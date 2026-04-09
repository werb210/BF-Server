import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { config } from "../config/index.js";
import { logger } from "../server/utils/logger.js";
function isLoopback(req) {
    const ip = req.ip || "";
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.0.0.1");
}
function isCodespacesRuntime() {
    return (config.codespaces.enabled === "true" ||
        Boolean(config.codespaces.name) ||
        Boolean(config.codespaces.portForwardingDomain));
}
function isPublicHealthPath(req) {
    const path = req.path;
    return (path === "/health" ||
        path === "/ready" ||
        path === "/api/health" ||
        path === "/api/ready" ||
        path.startsWith("/api/_int") ||
        path.startsWith("/_int"));
}
function isAzureHttps(req) {
    // Azure sets one or more of these when TLS is terminated upstream
    return (req.secure === true ||
        req.get("x-forwarded-proto") === "https" ||
        typeof req.get("x-arr-ssl") === "string");
}
export function requireHttps(req, res, next) {
    if (!config.isProduction)
        return next();
    // Always allow internal routes (health/ready) and loopback
    if (isPublicHealthPath(req) || isLoopback(req) || isCodespacesRuntime())
        return next();
    if (!isAzureHttps(req)) {
        res.status(400).json({
            code: "https_required",
            message: "HTTPS is required.",
            requestId: res.locals.requestId ?? "unknown",
        });
        return;
    }
    next();
}
export const securityHeaders = helmet({
    contentSecurityPolicy: false,
});
export const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
        trustProxy: false,
    },
});
export function productionLogger(req, _res, next) {
    if (config.env === "production") {
        logger.info("production_request", { method: req.method, url: req.originalUrl });
    }
    next();
}
