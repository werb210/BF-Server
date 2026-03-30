"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimitKeyFromRequest = rateLimitKeyFromRequest;
function rateLimitKeyFromRequest(req) {
    try {
        const forwarded = req.headers["x-forwarded-for"];
        if (typeof forwarded === "string") {
            return forwarded.split(",")[0]?.split(":")[0] ?? "unknown";
        }
        if (req.ip) {
            return req.ip.split(":")[0] ?? "unknown";
        }
        return "unknown";
    }
    catch {
        return "unknown";
    }
}
