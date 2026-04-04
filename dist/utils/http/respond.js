"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(res, data, status = 200) {
    const body = { status: "ok", data };
    res.locals.__wrapped = true;
    return res.status(status).json(body);
}
function fail(res, message, status = 400, _code, _details) {
    const body = {
        status: "error",
        error: message,
    };
    res.locals.__wrapped = true;
    return res.status(status).json(body);
}
