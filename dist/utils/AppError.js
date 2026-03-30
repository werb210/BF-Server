"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
class AppError extends Error {
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}
exports.AppError = AppError;
