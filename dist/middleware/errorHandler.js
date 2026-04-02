"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const response_1 = require("../system/response");
function errorHandler(err, _req, res, next) {
    if (res.headersSent) {
        return next(err);
    }
    res.locals.__wrapped = true;
    return res.status(500).json((0, response_1.fail)("INTERNAL_ERROR", _req.rid));
}
