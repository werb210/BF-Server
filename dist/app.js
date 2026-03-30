"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
exports.buildAppWithApiRoutes = buildAppWithApiRoutes;
const createServer_1 = require("./server/createServer");
const express_1 = __importDefault(require("express"));
const routeRegistry_1 = require("./routes/routeRegistry");
const health_1 = __importDefault(require("./routes/health"));
const requestContext_1 = require("./observability/requestContext");
const errorHandler_1 = require("./middleware/errorHandler");
const security_1 = require("./middleware/security");
const cors_1 = require("./middleware/cors");
const httpMetrics_1 = require("./metrics/httpMetrics");
function buildAppWithApiRoutes() {
    const app = (0, express_1.default)();
    app.use(security_1.securityHeaders);
    app.use(cors_1.corsMiddleware);
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use(express_1.default.urlencoded({ limit: "1mb", extended: true }));
    app.use(requestContext_1.requestContextMiddleware);
    app.use(httpMetrics_1.httpMetricsMiddleware);
    app.use(health_1.default);
    (0, routeRegistry_1.registerApiRouteMounts)(app);
    app.use(errorHandler_1.errorHandler);
    return app;
}
exports.app = (0, createServer_1.createServer)();
