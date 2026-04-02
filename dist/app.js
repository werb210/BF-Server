"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = exports.buildAppWithApiRoutes = void 0;
exports.resetOtpStateForTests = resetOtpStateForTests;
exports.createApp = createApp;
const express_1 = __importDefault(require("express"));
const auth_1 = require("./middleware/auth");
const routeAlias_1 = require("./middleware/routeAlias");
const internal_1 = __importDefault(require("./routes/internal"));
const routes_1 = __importDefault(require("./routes"));
const auth_routes_1 = __importDefault(require("./modules/auth/auth.routes"));
const messaging_1 = __importDefault(require("./routes/messaging"));
const maya_1 = __importDefault(require("./routes/maya"));
const voice_1 = __importDefault(require("./routes/voice"));
const sms_1 = __importDefault(require("./routes/sms"));
const health_1 = __importStar(require("./routes/health"));
const crm_1 = __importDefault(require("./routes/crm"));
const calls_1 = __importDefault(require("./routes/calls"));
const twilio_1 = __importDefault(require("./routes/twilio"));
const lead_1 = __importDefault(require("./routes/lead"));
const application_1 = __importDefault(require("./routes/application"));
const documents_1 = __importDefault(require("./routes/documents"));
const errorHandler_1 = require("./middleware/errorHandler");
const response_1 = require("./lib/response");
const routeWrap_1 = require("./lib/routeWrap");
const apiResponse_1 = require("./lib/apiResponse");
const timeout_1 = require("./system/timeout");
const requestId_1 = require("./system/requestId");
const access_1 = require("./system/access");
const metrics_1 = require("./system/metrics");
const rateLimit_1 = require("./system/rateLimit");
const config_1 = require("./system/config");
const response_2 = require("./system/response");
function resetOtpStateForTests() { }
globalThis.__resetOtpStateForTests = resetOtpStateForTests;
function createApp() {
    process.env.STRICT_API = config_1.CONFIG.STRICT_API;
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use((0, requestId_1.requestId)());
    app.use((0, access_1.access)());
    app.use((req, _res, next) => {
        (0, metrics_1.incReq)();
        next();
    });
    app.use((0, timeout_1.timeout)(config_1.CONFIG.REQUEST_TIMEOUT_MS));
    app.use((0, rateLimit_1.rateLimit)());
    app.use((req, res, next) => {
        if (["POST", "PUT", "PATCH"].includes(req.method)) {
            const body = req.body;
            if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
                res.locals.__wrapped = true;
                return res.status(400).json((0, response_2.fail)("INVALID_REQUEST_BODY", req.rid));
            }
        }
        return next();
    });
    app.use((req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-XSS-Protection", "1; mode=block");
        next();
    });
    app.get("/health", health_1.health);
    app.get("/ready", health_1.ready);
    app.get("/metrics", (_req, res) => {
        return res.json((0, metrics_1.metrics)());
    });
    app.use(routeAlias_1.routeAlias);
    app.use((req, res, next) => {
        const configured = config_1.CONFIG.CORS_ALLOWED_ORIGINS
            .split(",")
            .map((origin) => origin.trim())
            .filter(Boolean);
        const origin = req.headers.origin;
        if (origin && (configured.includes("*") || configured.includes(origin))) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Access-Control-Allow-Credentials", "true");
        }
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
        if (req.method === "OPTIONS") {
            res.locals.__wrapped = true;
            return res.status(200).send();
        }
        return next();
    });
    app.use("/api/v1", routes_1.default);
    app.get("/api/v1/public/test", (0, routeWrap_1.wrap)(async (_req, res) => {
        return (0, apiResponse_1.ok)({ ok: true });
    }));
    app.use("/api/v1/auth", auth_routes_1.default);
    app.use("/api/v1/crm", crm_1.default);
    app.use("/api/v1/crm", lead_1.default);
    app.use("/api/v1/application", application_1.default);
    app.use("/api/v1/documents", documents_1.default);
    app.use("/", twilio_1.default);
    app.use("/api/v1/maya", maya_1.default);
    app.use("/api/v1/voice", voice_1.default);
    app.use("/api/v1/call", calls_1.default);
    app.use("/api/v1", twilio_1.default);
    app.use("/api/v1/comm", messaging_1.default);
    app.use("/api/v1/sms", sms_1.default);
    app.use("/api/v1", health_1.default);
    app.get("/api/v1/voice/token", auth_1.requireAuth, (0, routeWrap_1.wrap)(async () => {
        return (0, apiResponse_1.ok)({ token: "real-token" });
    }));
    app.use("/api/v1/private", auth_1.requireAuth, (0, routeWrap_1.wrap)(async () => {
        return (0, apiResponse_1.ok)({ ok: true });
    }));
    app.use("/api/v1/internal", internal_1.default);
    app.use((req, res) => {
        if (!res.headersSent && !res.locals.__wrapped) {
            return (0, response_1.fail)(res, 500, "UNWRAPPED_RESPONSE");
        }
        return undefined;
    });
    app.use(errorHandler_1.errorHandler);
    app.use((_req, res) => {
        if (!res.headersSent) {
            return (0, response_1.fail)(res, 500, "UNHANDLED_ROUTE");
        }
        return undefined;
    });
    return app;
}
exports.buildAppWithApiRoutes = createApp;
exports.app = createApp();
exports.default = exports.app;
