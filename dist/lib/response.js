"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
function ok(res, data) {
    if (data === undefined) {
        throw new Error("OK_RESPONSE_MISSING_DATA");
    }
    return res.status(200).send({ success: true, data });
}
function fail(res, error, code = 400) {
    if (!error) {
        throw new Error("FAIL_RESPONSE_MISSING_ERROR");
    }
    return res.status(code).send({ success: false, error });
}
