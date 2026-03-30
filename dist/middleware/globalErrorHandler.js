"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalErrorHandler = globalErrorHandler;
const AppError_1 = require("../core/errors/AppError");
function globalErrorHandler(err, _req, res, _next) {
    if (err instanceof AppError_1.AppError) {
        return res.status(err.status).json({
            success: false,
            code: err.code,
            message: err.message,
            details: err.details ?? null
        });
    }
    console.error("UNHANDLED_ERROR", err);
    return res.status(500).json({
        success: false,
        code: "internal_error",
        message: "Internal server error",
        details: null
    });
}
