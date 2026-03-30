"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.apiLimiter = exports.securityHeaders = void 0;
exports.requireHttps = requireHttps;
exports.productionLogger = productionLogger;
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const config_1 = require("../config");
const logger_1 = require("../server/utils/logger");
function isLoopback(req) {
    const ip = req.ip || "";
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("::ffff:127.0.0.1");
}
function isCodespacesRuntime() {
    return (config_1.config.codespaces.enabled === "true" ||
        Boolean(config_1.config.codespaces.name) ||
        Boolean(config_1.config.codespaces.portForwardingDomain));
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
function requireHttps(req, res, next) {
    if (!config_1.config.isProduction)
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
exports.securityHeaders = (0, helmet_1.default)({
    contentSecurityPolicy: false,
});
exports.apiLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
        trustProxy: false,
    },
});
function productionLogger(req, _res, next) {
    if (config_1.config.env === "production") {
        logger_1.logger.info("production_request", { method: req.method, url: req.originalUrl });
    }
    next();
}
