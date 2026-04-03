"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
const metrics_1 = require("../system/metrics");
function requestLogger(req, res, next) {
    (0, metrics_1.trackRequest)();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    req.requestId = id;
    req.id = id;
    res.setHeader("X-Request-Id", id);
    console.log({
        id,
        method: req.method,
        path: req.path,
        time: new Date().toISOString(),
    });
    next();
}
