"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
exports.isAppError = isAppError;
exports.forbiddenError = forbiddenError;
exports.notFoundHandler = notFoundHandler;
exports.errorHandler = errorHandler;
const dbRuntime_1 = require("../dbRuntime");
const logger_1 = require("../observability/logger");
const appInsights_1 = require("../observability/appInsights");
const errors_1 = require("../helpers/errors");
class AppError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
exports.AppError = AppError;
function isAppError(value) {
    if (value instanceof AppError) {
        return true;
    }
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const status = value.status;
    const code = value.code;
    const message = value.message;
    return (typeof status === "number" &&
        Number.isFinite(status) &&
        typeof code === "string" &&
        code.length > 0 &&
        typeof message === "string" &&
        message.length > 0);
}
function forbiddenError(message = "Access denied.") {
    return new AppError("forbidden", message, 403);
}
const AUTH_FAILURE_CODES = new Set([
    "invalid_credentials",
    "account_disabled",
    "invalid_token",
    "missing_token",
    "missing_fields",
    "invalid_phone",
    "validation_error",
    "otp_failed",
    "twilio_error",
    "twilio_auth_failed",
    "user_not_found",
    "locked",
    "user_disabled",
    "auth_unavailable",
    "service_unavailable",
]);
const CONSTRAINT_VIOLATION_CODES = new Set(["23502", "23503", "23505"]);
function isConstraintViolation(err) {
    const code = err.code;
    return typeof code === "string" && CONSTRAINT_VIOLATION_CODES.has(code);
}
function isTimeoutError(err) {
    const code = err.code?.toLowerCase() ?? "";
    const message = err.message.toLowerCase();
    return code === "etimedout" || message.includes("timeout");
}
function isAuthRoute(req) {
    const url = req.originalUrl ?? req.url ?? "";
    const path = url.split("?")[0] ?? "";
    return path.startsWith("/api/auth/");
}
function resolveFailureReason(err) {
    if (isAppError(err)) {
        return AUTH_FAILURE_CODES.has(err.code)
            ? "auth_failure"
            : "request_error";
    }
    if (isConstraintViolation(err))
        return "constraint_violation";
    if ((0, dbRuntime_1.isDbConnectionFailure)(err)) {
        return isTimeoutError(err) ? "db_timeout" : "db_unavailable";
    }
    return "server_error";
}
function normalizeAuthError(err) {
    if (isAppError(err)) {
        return {
            status: err.status,
            code: err.code,
            message: err.message,
            details: err.details,
        };
    }
    if ((0, dbRuntime_1.isDbConnectionFailure)(err)) {
        return {
            status: 500,
            code: "db_unavailable",
            message: "Database unavailable.",
        };
    }
    if ((0, errors_1.isHttpishError)(err)) {
        return {
            status: (0, errors_1.fetchStatus)(err),
            code: "auth_failed",
            message: "Authentication failed.",
        };
    }
    return {
        status: 500,
        code: "auth_failed",
        message: "Authentication failed.",
    };
}
function notFoundHandler(req, res) {
    const requestId = res.locals.requestId ?? "unknown";
    if (isAuthRoute(req)) {
        res.status(404).json({
            ok: false,
            data: null,
            error: {
                code: "not_found",
                message: "Not found",
            },
            requestId,
        });
        return;
    }
    res.status(404).json({
        code: "not_found",
        message: "Not found",
        requestId,
    });
}
function errorHandler(err, req, res, _next) {
    const requestId = res.locals.requestId ?? "unknown";
    const durationMs = res.locals.requestStart
        ? Date.now() - Number(res.locals.requestStart)
        : 0;
    const failureReason = resolveFailureReason(err);
    const logBase = {
        requestId,
        method: req.method,
        route: req.originalUrl,
        durationMs,
        failure_reason: failureReason,
    };
    // AUTH ROUTES — STRICT CONTRACT
    if (isAuthRoute(req)) {
        const normalized = normalizeAuthError(err);
        const status = normalized.status;
        const useRawMessage = typeof err.message === "string" &&
            err.message.toLowerCase().includes("accesstoken missing");
        const errorPayload = useRawMessage
            ? err.message
            : {
                code: normalized.code,
                message: normalized.message,
                ...(normalized.details ? { details: normalized.details } : {}),
            };
        (0, logger_1.logError)("auth_request_failed", {
            ...logBase,
            status,
            code: normalized.code,
            message: normalized.message,
        });
        (0, appInsights_1.trackException)({
            exception: err,
            properties: {
                requestId,
                route: req.originalUrl,
                status,
                code: normalized.code,
                failure_reason: "auth_failure",
            },
        });
        res.status(status).json({
            ok: false,
            data: null,
            error: errorPayload,
            requestId,
        });
        return;
    }
    // APPLICATION ERRORS
    if (isAppError(err)) {
        (0, logger_1.logWarn)("request_error", {
            ...logBase,
            status: err.status,
            code: err.code,
            message: err.message,
        });
        (0, appInsights_1.trackException)({
            exception: err,
            properties: {
                requestId,
                route: req.originalUrl,
                status: err.status,
                code: err.code,
                failure_reason: failureReason,
            },
        });
        const details = err.details;
        res.status(err.status).json({
            code: err.code,
            message: err.message,
            ...(details ? { details } : {}),
            requestId,
        });
        return;
    }
    // DB CONSTRAINTS
    if (isConstraintViolation(err)) {
        (0, logger_1.logWarn)("request_error", {
            ...logBase,
            status: 409,
            code: "constraint_violation",
        });
        (0, appInsights_1.trackException)({
            exception: err,
            properties: {
                requestId,
                route: req.originalUrl,
                status: 409,
                code: "constraint_violation",
                failure_reason: failureReason,
            },
        });
        res.status(409).json({
            code: "constraint_violation",
            message: "Constraint violation.",
            requestId,
        });
        return;
    }
    // DB CONNECTION ERRORS
    if ((0, dbRuntime_1.isDbConnectionFailure)(err)) {
        (0, logger_1.logError)("request_error", {
            ...logBase,
            status: 500,
            code: "db_unavailable",
        });
        (0, appInsights_1.trackException)({
            exception: err,
            properties: {
                requestId,
                route: req.originalUrl,
                status: 500,
                code: "db_unavailable",
                failure_reason: failureReason,
            },
        });
        res.status(500).json({
            code: "db_unavailable",
            message: isTimeoutError(err) ? "Database timeout." : "Database unavailable.",
            requestId,
        });
        return;
    }
    // UNKNOWN
    (0, logger_1.logError)("request_error", {
        ...logBase,
        status: 500,
        code: "internal_error",
        message: err.message,
    });
    (0, appInsights_1.trackException)({
        exception: err,
        properties: {
            requestId,
            route: req.originalUrl,
            status: 500,
            code: "internal_error",
            failure_reason: failureReason,
        },
    });
    res.status(500).json({
        code: "internal_error",
        message: "Unexpected error",
        requestId,
    });
}
