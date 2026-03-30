"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHttpishError = isHttpishError;
exports.fetchStatus = fetchStatus;
/**
 * Narrow check for HTTP-like errors.
 * Only accepts finite numeric status codes.
 */
function isHttpishError(error) {
    if (typeof error !== "object" || error === null) {
        return false;
    }
    const status = error.status;
    return typeof status === "number" && Number.isFinite(status);
}
/**
 * Extract a safe HTTP status code.
 * Defaults to 500 if invalid or out of range.
 */
function fetchStatus(error) {
    if (isHttpishError(error)) {
        const { status } = error;
        if (status >= 400 && status <= 599) {
            return status;
        }
    }
    return 500;
}
