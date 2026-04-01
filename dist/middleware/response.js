"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ok = ok;
exports.fail = fail;
const apiResponse_1 = require("../lib/apiResponse");
function ok(res, data = {}) {
    return res.json((0, apiResponse_1.ok)(data));
}
function fail(res, status = 500, message = "error") {
    return res.status(status).json((0, apiResponse_1.fail)(String(status), message));
}
