"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(data, rid) {
    const result = {
        status: "ok",
        data,
    };
    if (rid !== undefined) {
        result.rid = rid;
    }
    return result;
}
function fail(error, rid) {
    const result = {
        status: "error",
        error,
    };
    if (rid !== undefined) {
        result.rid = rid;
    }
    return result;
}
