"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsRoute = metricsRoute;
const metrics_1 = require("../system/metrics");
const response_1 = require("../lib/response");
function metricsRoute(req, res) {
    return (0, response_1.ok)((0, metrics_1.getMetrics)(), req.rid);
}
