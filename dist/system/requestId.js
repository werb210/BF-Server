"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestId = requestId;
const crypto_1 = require("crypto");
function requestId() {
    return (req, res, next) => {
        const incoming = req.headers["x-request-id"];
        const id = typeof incoming === "string" && incoming.trim().length > 0 ? incoming : (0, crypto_1.randomUUID)();
        req.rid = id;
        req.requestId = id;
        req.id = id;
        res.locals.requestId = id;
        res.setHeader("x-request-id", id);
        next();
    };
}
