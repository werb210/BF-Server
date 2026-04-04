"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeout = timeout;
const respond_1 = require("../utils/http/respond");
function timeout(ms = 15000) {
    return (_req, res, next) => {
        const id = setTimeout(() => {
            if (!res.headersSent) {
                (0, respond_1.fail)(res, "Request timeout", 503, "TIMEOUT");
            }
        }, ms);
        res.on("finish", () => clearTimeout(id));
        res.on("close", () => clearTimeout(id));
        next();
    };
}
