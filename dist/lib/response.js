"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.error = error;
function ok(data, rid) {
    return {
        status: "ok",
        data,
        rid,
    };
}
function error(message, rid) {
    return {
        status: "error",
        error: message,
        rid,
    };
}
