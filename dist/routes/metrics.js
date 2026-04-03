"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsRoute = metricsRoute;
const metrics_1 = require("@/system/metrics");
const respond_1 = require("@/lib/respond");
function metricsRoute(req, res) {
    return (0, respond_1.ok)(res, (0, metrics_1.getMetrics)());
}
