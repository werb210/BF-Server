"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
function errorHandler(err, _req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    res.locals.__wrapped = true;
    return res.status(500).json({
        status: "error",
        error: {
            code: "INTERNAL_ERROR",
            message: err?.message || "Internal server error",
        },
    });
}
