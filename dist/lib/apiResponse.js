"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(data) {
    return { status: "ok", data };
}
function fail(_res, code, message) {
    return {
        status: "error",
        error: message ?? code,
    };
}
