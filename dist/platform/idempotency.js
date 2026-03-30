"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.idempotency = idempotency;
const crypto_1 = require("crypto");
const idempotencyStore_1 = require("../lib/idempotencyStore");
const logger_1 = require("../observability/logger");
const ENFORCED_METHODS = new Set(["POST", "PATCH", "DELETE"]);
const inFlightRequests = new Map();
function stableStringify(value) {
    if (value === null || value === undefined)
        return "null";
    if (typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const record = value;
    const sortedKeys = Object.keys(record).sort();
    return `{${sortedKeys
        .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
        .join(",")}}`;
}
function requestHash(req) {
    const payload = `${req.method}:${req.path}:${stableStringify(req.body ?? {})}`;
    return (0, crypto_1.createHash)("sha256").update(payload).digest("hex");
}
function normalizePath(req) {
    const rawPath = (req.originalUrl ?? req.path).split("?")[0] ?? req.path;
    return rawPath.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":id");
}
function buildStoreKey(req, key) {
    const userId = req.user?.id || "anon";
    return `idemp:${userId}:${normalizePath(req)}:${key}`;
}
function allowReplayOnHashMismatch(req) {
    const path = normalizePath(req);
    return path === "/api/client/submissions" || path === "/api/client/documents";
}
async function idempotency(req, res, next) {
    if (!ENFORCED_METHODS.has(req.method.toUpperCase())) {
        next();
        return;
    }
    const key = req.get("idempotency-key")?.trim();
    if (!key) {
        next();
        return;
    }
    const storeKey = buildStoreKey(req, key);
    const hash = requestHash(req);
    const existingInFlight = inFlightRequests.get(storeKey);
    if (existingInFlight) {
        await existingInFlight;
        const replay = await (0, idempotencyStore_1.fetchStoredResponse)(storeKey);
        if (replay) {
            (0, logger_1.logInfo)("idempotent_request_replayed", { key, route: req.path });
            res.status(replay.statusCode).json(replay.body);
            return;
        }
    }
    const cached = await (0, idempotencyStore_1.fetchStoredResponse)(storeKey);
    if (cached) {
        if (cached.requestHash !== hash) {
            if (!allowReplayOnHashMismatch(req)) {
                res.status(409).json({
                    code: "idempotency_conflict",
                    message: "Idempotency key reused with a different request payload.",
                });
                return;
            }
            (0, logger_1.logWarn)("idempotency_hash_mismatch_replayed", {
                key,
                route: req.path,
            });
        }
        (0, logger_1.logInfo)("idempotent_request_replayed", { key, route: req.path });
        res.status(cached.statusCode).json(cached.body);
        return;
    }
    const finalize = new Promise((resolve) => {
        res.on("finish", resolve);
        res.on("close", resolve);
    });
    inFlightRequests.set(storeKey, finalize);
    const originalJson = res["json"].bind(res);
    res["json"] = ((body) => {
        if (res.statusCode < 500) {
            void (0, idempotencyStore_1.storeResponse)(storeKey, {
                statusCode: res.statusCode,
                body,
                requestHash: hash,
                storedAt: Date.now(),
            }).catch((error) => {
                (0, logger_1.logWarn)("idempotency_store_failed", {
                    key,
                    route: req.path,
                    error: error instanceof Error ? error.message : "store_failed",
                });
            });
            (0, logger_1.logInfo)("idempotent_request_recorded", { key, route: req.path });
        }
        return originalJson(body);
    });
    finalize.finally(() => {
        inFlightRequests.delete(storeKey);
    });
    next();
}
