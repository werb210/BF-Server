"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpRequestDuration = exports.requestErrorsTotal = exports.requestsTotal = void 0;
exports.httpMetricsMiddleware = httpMetricsMiddleware;
const prom_client_1 = __importDefault(require("prom-client"));
exports.requestsTotal = new prom_client_1.default.Counter({
    name: "requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route"],
});
exports.requestErrorsTotal = new prom_client_1.default.Counter({
    name: "request_errors_total",
    help: "Total number of HTTP 5xx responses",
    labelNames: ["method", "route", "status"],
});
exports.httpRequestDuration = new prom_client_1.default.Histogram({
    name: "request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status"],
});
function httpMetricsMiddleware(req, res, next) {
    const route = req.route?.path ?? req.path;
    exports.requestsTotal.inc({ method: req.method, route });
    const end = exports.httpRequestDuration.startTimer();
    res.on("finish", () => {
        const status = String(res.statusCode);
        end({
            method: req.method,
            route,
            status,
        });
        if (res.statusCode >= 500) {
            exports.requestErrorsTotal.inc({ method: req.method, route, status });
        }
    });
    next();
}
