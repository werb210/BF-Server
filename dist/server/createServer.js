"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const cors_1 = require("../middleware/cors");
const security_1 = require("../middleware/security");
const httpMetrics_1 = require("../metrics/httpMetrics");
const requestContext_1 = require("../observability/requestContext");
const errorHandler_1 = require("../middleware/errorHandler");
const routeRegistry_1 = require("../routes/routeRegistry");
const auth_routes_1 = __importDefault(require("../routes/auth.routes"));
const auth_1 = require("../middleware/auth");
const me_1 = require("../routes/auth/me");
function createServer() {
    const app = (0, express_1.default)();
    app.use(security_1.securityHeaders);
    app.use(cors_1.corsMiddleware);
    app.use((0, cookie_parser_1.default)());
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use(express_1.default.urlencoded({ limit: "1mb", extended: true }));
    app.use(requestContext_1.requestContextMiddleware);
    app.use(httpMetrics_1.httpMetricsMiddleware);
    app.get("/", (_req, res) => {
        res.status(200).send("ok");
    });
    app.get("/health", (_req, res) => {
        res.status(200).json({ status: "ok" });
    });
    app.get("/api/health", (_req, res) => {
        res.status(200).json({ status: "ok" });
    });
    app.use("/auth", auth_routes_1.default);
    app.use("/api/auth", auth_routes_1.default);
    app.get("/api/auth/me", auth_1.requireAuth, me_1.authMeHandler);
    (0, routeRegistry_1.registerApiRouteMounts)(app);
    app.use(errorHandler_1.errorHandler);
    return app;
}
