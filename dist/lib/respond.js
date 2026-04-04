"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.error = error;
function ok(res, data = {}) {
    return res.status(200).json({
        status: "ok",
        data,
    });
}
function error(res, message = "error", code = 500) {
    return res.status(code).json({
        status: "error",
        error: message,
    });
}
