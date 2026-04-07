"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeout = timeout;
const response_1 = require("../lib/response");
function timeout(ms = 15000) {
    return (_req, res, next) => {
        const id = setTimeout(() => {
            if (!res.headersSent) {
                res.status(503).json((0, response_1.fail)("Request timeout", _req.rid));
            }
        }, ms);
        res.on("finish", () => clearTimeout(id));
        res.on("close", () => clearTimeout(id));
        next();
    };
}
