"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = requestLogger;
const logger_1 = require("../server/utils/logger");
const metrics_1 = require("../routes/metrics");
function requestLogger(req, res, next) {
    (0, metrics_1.trackRequest)();
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        logger_1.logger.info('request', {
            requestId: req.id,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            duration
        });
    });
    next();
}
