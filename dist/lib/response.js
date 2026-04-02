"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
const response_1 = require("../system/response");
function ok(res, data) {
    res.locals.__wrapped = true;
    return res.status(200).json((0, response_1.ok)(data, res.locals.requestId));
}
function fail(res, code, message) {
    res.locals.__wrapped = true;
    return res.status(code).json((0, response_1.fail)(message, res.locals.requestId));
}
