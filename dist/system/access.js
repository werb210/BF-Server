"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.access = access;
const logger_1 = require("./logger");
const metrics_1 = require("./metrics");
function access() {
    return (req, res, next) => {
        const start = Date.now();
        res.on("finish", () => {
            if (res.statusCode >= 500) {
                (0, metrics_1.incErr)();
            }
            (0, logger_1.log)("info", "request", {
                rid: req.rid,
                method: req.method,
                path: req.originalUrl,
                status: res.statusCode,
                ms: Date.now() - start,
            });
        });
        next();
    };
}
