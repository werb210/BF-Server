"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function toErrorCode(error) {
    if (typeof error === "string" && error.trim().length > 0) {
        return error.trim();
    }
    if (error && typeof error === "object") {
        const payload = error;
        if (typeof payload.code === "string" && payload.code.trim().length > 0) {
            return payload.code.trim();
        }
        if (typeof payload.message === "string" && payload.message.trim().length > 0) {
            return payload.message.trim().toUpperCase().replace(/\s+/g, "_");
        }
        if (typeof payload.error === "string" && payload.error.trim().length > 0) {
            return payload.error.trim();
        }
    }
    return "UNKNOWN_ERROR";
}
function ok(data, rid) {
    return { status: "ok", data, rid };
}
function fail(error, rid) {
    return {
        status: "error",
        error: toErrorCode(error),
        rid,
    };
}
