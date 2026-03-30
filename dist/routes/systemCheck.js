"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = __importDefault(require("crypto"));
const express_1 = require("express");
const config_1 = require("../config");
const dbClient_1 = require("../lib/dbClient");
const redis_1 = require("../lib/redis");
const otpService_1 = require("../services/otpService");
const systemCheckRouter = (0, express_1.Router)();
function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return "unknown_error";
}
systemCheckRouter.get("/system-check", async (_req, res) => {
    const tests = {
        db: { status: "fail" },
        users: { status: "fail" },
        lenders: { status: "fail" },
        products: { status: "fail" },
        otp: { status: "fail", stored: null, expected: "654321" },
        redis: { status: "missing" },
        env: {
            db: Boolean(config_1.config.db.host?.trim()),
            dbSsl: String(config_1.config.db.ssl ?? "").trim().toLowerCase() === "true",
            redis: Boolean(config_1.config.redis.url?.trim()),
            jwt: Boolean(config_1.config.jwt.secret?.trim()),
        },
    };
    try {
        await dbClient_1.pool.query("SELECT 1");
        tests.db.status = "ok";
    }
    catch (error) {
        tests.db = { status: "fail", error: toErrorMessage(error) };
    }
    let userId = null;
    try {
        userId = crypto_1.default.randomUUID();
        const email = `system-check+${Date.now()}@example.com`;
        await dbClient_1.pool.query(`
        INSERT INTO users (id, email, password_hash, role, active)
        VALUES ($1, $2, $3, $4, $5)
      `, [userId, email, "system-check", "admin", true]);
        const read = await dbClient_1.pool.query(`
        SELECT id
        FROM users
        WHERE id = $1
        LIMIT 1
      `, [userId]);
        await dbClient_1.pool.query("DELETE FROM users WHERE id = $1", [userId]);
        userId = null;
        tests.users.status = (read.rowCount ?? 0) > 0 ? "ok" : "fail";
        if (tests.users.status === "fail") {
            tests.users.error = "inserted_user_not_found";
        }
    }
    catch (error) {
        tests.users = { status: "fail", error: toErrorMessage(error) };
        if (userId) {
            try {
                await dbClient_1.pool.query("DELETE FROM users WHERE id = $1", [userId]);
            }
            catch {
                // best-effort cleanup
            }
        }
    }
    try {
        const result = await dbClient_1.pool.query("SELECT count(*)::int AS count FROM lenders");
        tests.lenders = { status: "ok", count: result.rows[0]?.count ?? 0 };
    }
    catch (error) {
        tests.lenders = { status: "fail", error: toErrorMessage(error) };
    }
    try {
        const result = await dbClient_1.pool.query("SELECT count(*)::int AS count FROM lender_products");
        tests.products = { status: "ok", count: result.rows[0]?.count ?? 0 };
    }
    catch (error) {
        tests.products = { status: "fail", error: toErrorMessage(error) };
    }
    try {
        const phone = "+15555550123";
        const expected = tests.otp.expected;
        await (0, otpService_1.storeOtp)(phone, expected);
        const stored = await (0, otpService_1.fetchOtp)(phone);
        tests.otp.stored = stored;
        tests.otp.status = stored === expected ? "ok" : "fail";
    }
    catch (error) {
        tests.otp = {
            status: "fail",
            expected: tests.otp.expected,
            stored: null,
            error: toErrorMessage(error),
        };
    }
    if (!redis_1.redis) {
        tests.redis.status = "missing";
    }
    else {
        try {
            const key = `system-check:${Date.now()}`;
            const expected = "ok";
            await redis_1.redis.set(key, expected, "EX", 30);
            const value = await redis_1.redis.get(key);
            tests.redis.status = value === expected ? "ok" : "fail";
            if (tests.redis.status === "fail") {
                tests.redis.error = "redis_set_get_mismatch";
            }
            await redis_1.redis.del(key);
        }
        catch (error) {
            tests.redis = { status: "fail", error: toErrorMessage(error) };
        }
    }
    const hasFailingTest = [
        tests.db.status,
        tests.users.status,
        tests.lenders.status,
        tests.products.status,
        tests.otp.status,
        tests.redis.status,
    ].some((status) => status === "fail");
    res.status(hasFailingTest ? 500 : 200).json({
        status: hasFailingTest ? "fail" : "ok",
        tests,
    });
});
exports.default = systemCheckRouter;
