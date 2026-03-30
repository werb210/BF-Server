"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
class AppError extends Error {
    status;
    code;
    details;
    constructor(message, status = 500, code = "internal_error", details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        Object.setPrototypeOf(this, AppError.prototype);
    }
    static badRequest(message, code = "bad_request", details) {
        return new AppError(message, 400, code, details);
    }
    static unauthorized(message = "Unauthorized") {
        return new AppError(message, 401, "unauthorized");
    }
    static forbidden(message = "Forbidden") {
        return new AppError(message, 403, "forbidden");
    }
    static notFound(message = "Not found") {
        return new AppError(message, 404, "not_found");
    }
}
exports.AppError = AppError;
