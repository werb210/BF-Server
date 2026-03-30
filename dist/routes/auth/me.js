"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMeHandler = authMeHandler;
const silo_1 = require("../../auth/silo");
const requestContext_1 = require("../../observability/requestContext");
const auth_repo_1 = require("../../modules/auth/auth.repo");
const logger_1 = require("../../observability/logger");
const auth_validation_1 = require("../../validation/auth.validation");
function fetchAuthRequestId(res) {
    return res.locals.requestId ?? (0, requestContext_1.fetchRequestId)() ?? "unknown";
}
function respondAuthError(res, status, code, message) {
    const requestId = fetchAuthRequestId(res);
    res.set("Cache-Control", "no-store");
    res.status(status).json({
        success: false,
        code,
        message,
        data: null,
        ok: false,
        error: { code, message },
        requestId,
    });
}
function respondResponseValidationError(res, route, requestId, errors) {
    (0, logger_1.logError)("auth_response_validation_failed", {
        route,
        requestId,
        errors,
    });
    res.set("Cache-Control", "no-store");
    res.status(500).json({
        success: false,
        code: "invalid_response_shape",
        message: "Invalid auth response shape",
        data: null,
        ok: false,
        error: { code: "invalid_response_shape", message: "Invalid auth response shape" },
        requestId,
    });
}
async function authMeHandler(req, res) {
    const route = "/api/auth/me";
    const requestId = fetchAuthRequestId(res);
    try {
        const user = req.user;
        if (!user) {
            respondAuthError(res, 401, "missing_token", "Authorization token is required.");
            return;
        }
        let silo = user.silo;
        if (!user.siloFromToken) {
            try {
                const userRecord = await (0, auth_repo_1.findAuthUserById)(user.userId);
                if (userRecord?.silo?.trim()) {
                    silo = userRecord.silo.trim();
                }
                else {
                    silo = silo_1.DEFAULT_AUTH_SILO;
                }
            }
            catch (err) {
                (0, logger_1.logError)("auth_me_silo_lookup_failed", {
                    route,
                    requestId,
                    userId: user.userId,
                    err,
                });
                silo = silo_1.DEFAULT_AUTH_SILO;
            }
        }
        if (!silo?.trim()) {
            silo = silo_1.DEFAULT_AUTH_SILO;
        }
        const responseBody = {
            success: true,
            ok: true,
            data: {
                user: {
                    id: user.userId,
                    role: user.role,
                    silo,
                    phone: user.phone,
                },
            },
            userId: user.userId,
            role: user.role,
            silo,
            user: {
                id: user.userId,
                role: user.role,
                silo,
                phone: user.phone,
            },
        };
        const validation = (0, auth_validation_1.validateAuthMe)(responseBody);
        if (!validation.success) {
            respondResponseValidationError(res, route, requestId, validation.error.flatten());
            return;
        }
        res.set("Cache-Control", "no-store");
        res.status(200).json(responseBody);
    }
    catch (err) {
        (0, logger_1.logError)("auth_me_failed", {
            route,
            requestId,
            err,
        });
        respondAuthError(res, 401, "invalid_token", "Invalid or expired authorization token.");
    }
}
