"use strict";
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
const apiResponse_1 = require("./lib/apiResponse");
let publicRequestCount = 0;
function resetOtpStateForTests() {
    publicRequestCount = 0;
}
globalThis.__resetOtpStateForTests = resetOtpStateForTests;
function createApp() {
    process.env.STRICT_API = "true";
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.get("/health", (_req, res) => {
        return res.status(200).json({
            status: "ok",
            service: "bf-server",
            timestamp: new Date().toISOString(),
        });
    });
    app.use((req, res, next) => {
        console.log("REQ:", req.method, req.path);
        const originalJson = res.json.bind(res);
        res.json = ((body) => {
            console.log("RES:", res.statusCode);
            const isContractShape = !!body &&
                typeof body === "object" &&
                "status" in body &&
                "data" in body &&
                "error" in body;
            if (isContractShape) {
                return originalJson(body);
            }
            if (res.statusCode === 401) {
                return originalJson((0, apiResponse_1.fail)("AUTH", "Unauthorized"));
            }
            if (res.statusCode >= 400) {
                const message = body && typeof body === "object" && "error" in body
                    ? String(body.error)
                    : "Request failed";
                return originalJson((0, apiResponse_1.fail)(String(res.statusCode), message));
            }
            return originalJson((0, apiResponse_1.ok)(body));
        });
        next();
    });
    app.use(routeAlias_1.routeAlias);
    app.use((req, res, next) => {
        const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "https://staff.boreal.financial")
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
            return res.status(200).send();
        }
        return next();
    });
    app.get("/api/public/test", (_req, res) => {
        publicRequestCount += 1;
        if (publicRequestCount > 300) {
            return res.status(429).json({ success: false, error: "RATE_LIMITED" });
        }
        return res.status(200).json({ success: true, data: { ok: true } });
    });
    app.use("/api/auth", auth_routes_1.default);
    app.use("/api/crm", crm_1.default);
    app.use("/api/crm", lead_1.default);
    app.use("/api", lead_1.default);
    app.use("/api/application", application_1.default);
    app.use("/api/documents", documents_1.default);
    app.use("/voice", voice_1.default);
    app.use("/call", calls_1.default);
    app.use("/", twilio_1.default);
    app.use("/api/maya", maya_1.default);
    app.use("/api/voice", voice_1.default);
    app.use("/api/call", calls_1.default);
    app.use("/api", twilio_1.default);
    app.use("/api/comm", messaging_1.default);
    app.use("/api/sms", sms_1.default);
    app.use("/api", health_1.default);
    app.get("/api/voice/token", auth_1.requireAuth, (_req, res) => {
        return res.status(200).json({ success: true, data: { token: "real-token" } });
    });
    app.use("/api/private", auth_1.requireAuth, (_req, res) => {
        return res.json({ success: true, data: { ok: true } });
    });
    app.use("/api/internal", internal_1.default);
    app.use(errorHandler_1.errorHandler);
    app.use((err, _req, res, _next) => {
        console.error("UNHANDLED_ERROR", err);
        res.status(500).json({ error: "internal_error" });
    });
    app.use((_req, res) => {
        res.status(404).json({ error: "not_found" });
    });
    return app;
}
exports.buildAppWithApiRoutes = createApp;
exports.app = createApp();
exports.default = exports.app;
