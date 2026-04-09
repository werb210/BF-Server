import { CONFIG } from "./config.js";
import { fail } from "./response.js";
const hits = new Map();
export function resetRateLimitForTests() {
    hits.clear();
}
export function rateLimit() {
    const limit = CONFIG.RATE_LIMIT;
    const windowMs = CONFIG.RATE_WINDOW_MS;
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
            return res.status(429).json(fail("RATE_LIMIT", req.rid));
        }
        return next();
    };
}
