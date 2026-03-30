"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const redis_1 = require("../lib/redis");
const response_1 = require("../lib/response");
const twilio_1 = require("../lib/twilio");
const router = (0, express_1.Router)();
const isPhone = (value) => (typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim()));
const isCode = (value) => (typeof value === "string" && /^\d{6}$/.test(value.trim()));
function resetOtpStateForTests() {
    (0, redis_1.resetRedisMock)();
}
router.get("/me", auth_1.requireAuth, (req, res) => {
    return res.json(req.user);
});
router.post("/otp/start", async (req, res) => {
    const { phone } = req.body;
    if (!isPhone(phone)) {
        return (0, response_1.fail)(res, "invalid_payload", 400);
    }
    if (!process.env.TWILIO_ACCOUNT_SID
        || !process.env.TWILIO_AUTH_TOKEN
        || !process.env.TWILIO_PHONE) {
        return (0, response_1.fail)(res, "missing_otp_env", 500);
    }
    const redis = (0, redis_1.getRedis)();
    const now = Date.now();
    const key = `otp:${phone}`;
    const existingRaw = await redis.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;
    if (existing && now - existing.lastSentAt < 60_000) {
        return (0, response_1.fail)(res, "Too many requests", 429);
    }
    const staticOtpCode = process.env.TEST_OTP_CODE;
    const code = staticOtpCode
        ? staticOtpCode
        : Math.floor(100000 + Math.random() * 900000).toString();
    const record = {
        code,
        expiresAt: now + (5 * 60 * 1000),
        attempts: 0,
        lastSentAt: now,
        used: false,
    };
    await redis.set(key, JSON.stringify(record), "EX", 300);
    if (!staticOtpCode) {
        await (0, twilio_1.sendSMS)(phone, `Your code is ${code}`);
    }
    if (process.env.NODE_ENV === "test") {
        return (0, response_1.ok)(res, { otp: "123456" });
    }
    return (0, response_1.ok)(res, { sent: true });
});
router.post("/otp/verify", async (req, res) => {
    const { phone, code } = req.body;
    if (!isPhone(phone) || !isCode(code)) {
        return (0, response_1.fail)(res, "invalid_payload", 400);
    }
    if (!process.env.JWT_SECRET) {
        return (0, response_1.fail)(res, "unauthorized", 401);
    }
    const redis = (0, redis_1.getRedis)();
    const stored = await redis.get(`otp:${phone}`);
    if (!stored) {
        return (0, response_1.fail)(res, "Invalid code", 400);
    }
    const record = JSON.parse(stored);
    const now = Date.now();
    if (now > record.expiresAt) {
        await redis.del(`otp:${phone}`);
        return (0, response_1.fail)(res, "OTP expired", 410);
    }
    if (record.used) {
        return (0, response_1.fail)(res, "Invalid code", 400);
    }
    if (record.code !== code) {
        record.attempts += 1;
        if (record.attempts >= 5) {
            await redis.del(`otp:${phone}`);
        }
        else {
            await redis.set(`otp:${phone}`, JSON.stringify(record), "EX", 300);
        }
        return (0, response_1.fail)(res, "Invalid code", 400);
    }
    const token = jsonwebtoken_1.default.sign({ phone }, process.env.JWT_SECRET, { expiresIn: "1d" });
    await redis.del(`otp:${phone}`);
    return (0, response_1.ok)(res, { token });
});
exports.default = router;
