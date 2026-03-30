"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.csrfProtection = void 0;
const config_1 = require("../config");
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function normalizeOrigin(value) {
    return value.trim().replace(/\/$/, "").toLowerCase();
}
function fetchTrustedOrigins() {
    const trustedOrigins = [config_1.config.client.url, config_1.config.portal.url, config_1.config.website.url];
    if (config_1.config.env !== "production") {
        trustedOrigins.push("https://server.boreal.financial");
    }
    return new Set(trustedOrigins
        .filter((origin) => typeof origin === "string" && origin.trim().length > 0)
        .map(normalizeOrigin));
}
function isCsrfExemptPath(path) {
    return (path.startsWith("/api/twilio") ||
        path.startsWith("/api/webhooks") ||
        path.startsWith("/api/voice"));
}
const csrfProtection = (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
        next();
        return;
    }
    if (isCsrfExemptPath(req.path)) {
        next();
        return;
    }
    const origin = req.get("origin") ?? req.get("referer");
    if (!origin) {
        next();
        return;
    }
    const trustedOrigins = fetchTrustedOrigins();
    const normalizedOrigin = normalizeOrigin(origin);
    if (!trustedOrigins.has(normalizedOrigin)) {
        res.status(403).json({
            ok: false,
            error: {
                code: "csrf_forbidden",
                message: "Request origin is not allowed.",
            },
        });
        return;
    }
    const csrfToken = req.get("x-csrf-token");
    const csrfCookie = req.get("cookie");
    const hasBrowserCookies = typeof csrfCookie === "string" && csrfCookie.includes("=");
    if (hasBrowserCookies && (!csrfToken || csrfToken.trim().length < 12)) {
        res.status(403).json({
            ok: false,
            error: {
                code: "csrf_token_required",
                message: "Missing CSRF token.",
            },
        });
        return;
    }
    next();
};
exports.csrfProtection = csrfProtection;
