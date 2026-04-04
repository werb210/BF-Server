"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetRateLimitForTests = resetRateLimitForTests;
exports.rateLimit = rateLimit;
const config_1 = require("./config");
const response_1 = require("./response");
const hits = new Map();
function resetRateLimitForTests() {
    hits.clear();
}
function rateLimit() {
    const limit = config_1.CONFIG.RATE_LIMIT;
    const windowMs = config_1.CONFIG.RATE_WINDOW_MS;
    return (req, res, next) => {
        const raw = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
            req.socket?.remoteAddress ||
            req.ip ||
            "unknown";
        const key = raw || "unknown";
        const now = Date.now();
        const entry = hits.get(key) || { count: 0, ts: now };
        if (now - entry.ts > windowMs) {
            entry.count = 0;
            entry.ts = now;
        }
        entry.count += 1;
        hits.set(key, entry);
        if (entry.count > limit) {
            res.setHeader("Retry-After", "1");
            return res.status(429).json((0, response_1.fail)("RATE_LIMIT", req.rid));
        }
        return next();
    };
}
