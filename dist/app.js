"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = exports.buildAppWithApiRoutes = void 0;
exports.resetOtpStateForTests = resetOtpStateForTests;
exports.createApp = createApp;
exports.buildApp = buildApp;
const express_1 = __importDefault(require("express"));
const cors_1 = require("./middleware/cors");
const requireAuth_1 = require("./middleware/requireAuth");
const routeAlias_1 = require("./middleware/routeAlias");
const internal_1 = __importDefault(require("./routes/internal"));
const routes_1 = __importDefault(require("./routes"));
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const messaging_1 = __importDefault(require("./routes/messaging"));
const maya_1 = __importDefault(require("./routes/maya"));
const voice_1 = __importDefault(require("./routes/voice"));
const sms_1 = __importDefault(require("./routes/sms"));
const health_1 = __importDefault(require("./routes/health"));
const crm_1 = __importDefault(require("./routes/crm"));
const calls_1 = __importDefault(require("./routes/calls"));
const twilio_1 = __importDefault(require("./routes/twilio"));
const lead_1 = __importDefault(require("./routes/lead"));
const application_1 = __importDefault(require("./routes/application"));
const documents_1 = __importDefault(require("./routes/documents"));
const errorHandler_1 = require("./middleware/errorHandler");
const response_1 = require("./middleware/response");
const timeout_1 = require("./system/timeout");
const requestContext_1 = require("./middleware/requestContext");
const access_1 = require("./system/access");
const metrics_1 = require("./system/metrics");
const rateLimit_1 = require("./system/rateLimit");
const config_1 = require("./system/config");
const deps_1 = require("./system/deps");
const ready_1 = require("./routes/ready");
function resetOtpStateForTests() { }
globalThis.__resetOtpStateForTests = resetOtpStateForTests;
function registerCommonMiddleware(app) {
    app.use(requestContext_1.requestContext);
    app.use((0, access_1.access)());
    app.use((req, _res, next) => {
        (0, metrics_1.incReq)();
        next();
    });
    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-XSS-Protection", "1; mode=block");
        next();
    });
}
function registerApiRoutes(app) {
    process.env.STRICT_API = config_1.CONFIG.STRICT_API;
    app.use(cors_1.corsMiddleware);
    app.use(express_1.default.json({ limit: "2mb" }));
    app.use((0, timeout_1.timeout)(config_1.CONFIG.REQUEST_TIMEOUT_MS));
    app.use((0, rateLimit_1.rateLimit)());
    app.use((req, res, next) => {
        if (["POST", "PUT", "PATCH"].includes(req.method)) {
            const body = req.body;
            if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
                res.locals.__wrapped = true;
                return (0, response_1.fail)(res, "Invalid request body", 400);
            }
        }
        return next();
    });
    app.get("/metrics", (0, response_1.wrap)(async () => {
        return {
            requests: (0, metrics_1.metrics)().requests,
            errors: (0, metrics_1.metrics)().errors,
        };
    }));
    app.use(routeAlias_1.routeAlias);
    app.use("/api/v1", routes_1.default);
    app.get("/api/v1/public/test", (0, response_1.wrap)(async () => {
        return { ok: true };
    }));
    app.use("/api/v1/auth", auth_routes_1.default);
    app.use("/api/v1/crm", crm_1.default);
    app.use("/api/v1/crm", lead_1.default);
    app.use("/api/v1/application", application_1.default);
    app.use("/api/v1/documents", documents_1.default);
    app.use("/api/v1/maya", maya_1.default);
    app.use("/api/v1/voice", voice_1.default);
    app.use("/api/v1/call", calls_1.default);
    app.use("/api/v1", twilio_1.default);
    app.use("/api/v1/comm", messaging_1.default);
    app.use("/api/v1/sms", sms_1.default);
    app.get("/api/v1/voice/token", requireAuth_1.requireAuth, (0, response_1.wrap)(async () => {
        return { token: "real-token" };
    }));
    app.use("/api/v1/private", requireAuth_1.requireAuth, (0, response_1.wrap)(async () => {
        return { ok: true };
    }));
    app.use("/api/v1/internal", internal_1.default);
    app.use((_req, res) => {
        if (!res.headersSent) {
            return (0, response_1.fail)(res, "Route not found", 404);
        }
        return undefined;
    });
    app.use(errorHandler_1.errorHandler);
}
function createApp(deps) {
    const app = (0, express_1.default)();
    // CRITICAL: attach SAME object reference used in tests
    app.locals.deps = deps;
    // OPTIONAL HARD LOCK: prevent accidental reassignment
    Object.defineProperty(app.locals, "deps", {
        writable: false,
        configurable: false,
    });
    registerCommonMiddleware(app);
    // ===== ROUTE ORDER (DO NOT CHANGE) =====
    // HEALTH FIRST — NEVER MOVE
    app.use("/health", health_1.default);
    // READINESS SECOND
    app.get("/ready", ready_1.readyHandler);
    // ALL OTHER ROUTES AFTER
    registerApiRoutes(app);
    return app;
}
async function buildApp() {
    return createApp(deps_1.deps);
}
exports.buildAppWithApiRoutes = createApp;
exports.app = createApp(deps_1.deps);
exports.default = exports.app;
