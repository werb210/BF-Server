"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeResolutionLogger = routeResolutionLogger;
const logger_1 = require("../observability/logger");
function routeResolutionLogger(req, res, next) {
    res.on("finish", () => {
        // If no route matched, Express never sets req.route
        if (!req.route) {
            return;
        }
        const requestId = res.locals.requestId ?? "unknown";
        (0, logger_1.logInfo)("route_resolved", {
            requestId,
            method: req.method,
            originalUrl: req.originalUrl,
            baseUrl: req.baseUrl || undefined,
            routePath: req.route.path,
        });
    });
    next();
}
