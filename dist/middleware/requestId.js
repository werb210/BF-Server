"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestId = requestId;
const crypto_1 = require("crypto");
function requestId(req, res, next) {
    const rid = (0, crypto_1.randomUUID)();
    req.rid = rid;
    res.setHeader("x-request-id", rid);
    next();
}
