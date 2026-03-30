"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
class AppError extends Error {
    status;
    code;
    constructor(message, status = 500, code = "INTERNAL_ERROR") {
        super(message);
        this.status = status;
        this.code = code;
    }
}
exports.AppError = AppError;
