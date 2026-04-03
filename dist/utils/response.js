"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fail = exports.ok = void 0;
exports.sendSuccess = sendSuccess;
exports.sendError = sendError;
const ok = (data) => ({
    status: "ok",
    data,
});
exports.ok = ok;
const fail = (error) => ({
    status: "error",
    error: {
        message: error,
    },
});
exports.fail = fail;
function sendSuccess(res, data, code = 200) {
    return res.status(code).json((0, exports.ok)(data));
}
function sendError(res, error, code = 500) {
    const normalized = typeof error === "string"
        ? { message: error }
        : { ...(error ?? {}), message: error?.message || "Unknown error" };
    return res.status(code).json({
        status: "error",
        error: normalized,
    });
}
