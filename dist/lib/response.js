"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(res, data) {
    return res.json({
        success: true,
        data,
    });
}
function fail(res, message, code = 400) {
    return res.status(code).json({
        success: false,
        error: message,
    });
}
