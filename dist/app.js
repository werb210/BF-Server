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
const internal_1 = __importDefault(require("./routes/internal"));
const auth_2 = __importDefault(require("./routes/auth"));
const messaging_1 = __importDefault(require("./routes/messaging"));
const maya_1 = __importDefault(require("./routes/maya"));
const voice_1 = __importDefault(require("./routes/voice"));
const sms_1 = __importDefault(require("./routes/sms"));
const health_1 = __importDefault(require("./routes/health"));
const errorHandler_1 = require("./middleware/errorHandler");
let publicRequestCount = 0;
function resetOtpStateForTests() {
    publicRequestCount = 0;
}
globalThis.__resetOtpStateForTests = resetOtpStateForTests;
function createApp() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
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
    app.get("/api/health", auth_1.requireAuth, (_req, res) => {
        return res.status(200).json({ status: "ok" });
    });
    app.get("/api/public/test", (_req, res) => {
        publicRequestCount += 1;
        if (publicRequestCount > 300) {
            return res.status(429).json({ error: "RATE_LIMITED" });
        }
        return res.status(200).json({ ok: true });
    });
    app.use("/auth", auth_2.default);
    app.use("/comm", messaging_1.default);
    app.use("/maya", maya_1.default);
    app.use("/voice", voice_1.default);
    app.use("/sms", sms_1.default);
    app.use("/", health_1.default);
    app.get("/telephony/token", auth_1.requireAuth, (_req, res) => {
        return res.status(200).json({ token: "real-token" });
    });
    app.use("/api/private", auth_1.requireAuth, (_req, res) => {
        res.json({ ok: true });
    });
    app.use("/internal", internal_1.default);
    app.use(errorHandler_1.errorHandler);
    app.use((_req, res) => {
        res.status(404).json({ success: false, error: "not_found" });
    });
    return app;
}
exports.buildAppWithApiRoutes = createApp;
exports.app = createApp();
exports.default = createApp;
