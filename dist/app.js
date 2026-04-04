"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = __importDefault(require("express"));
const cors_1 = require("./middleware/cors");
const routes_1 = __importDefault(require("./routes"));
const auth_1 = __importDefault(require("./routes/auth"));
const response_1 = require("./lib/response");
const env_1 = require("./config/env");
const allowedProductionHosts = ["server.boreal.financial"];
function createApp() {
    const app = (0, express_1.default)();
    app.get("/health", (_req, res) => {
        res.status(200).send("healthy");
    });
    app.get("/api/_int/health", (_req, res) => {
        res.json({
            status: "ok",
            uptime: process.uptime(),
        });
    });
    app.use((req, res, next) => {
        if (req.path === "/health" || req.path === "/api/_int/health") {
            return next();
        }
        const raw = req.headers.host || "";
        const normalized = raw.split(":")[0];
        const { NODE_ENV } = (0, env_1.getEnv)();
        if (NODE_ENV !== "production") {
            if (normalized === "localhost" || normalized === "127.0.0.1") {
                return next();
            }
        }
        if (!allowedProductionHosts.includes(normalized)) {
            return res.status(403).send("Forbidden");
        }
        next();
    });
    app.disable("x-powered-by");
    app.set("trust proxy", 1);
    app.use(express_1.default.json());
    app.use(cors_1.corsMiddleware);
    app.get("/", (_req, res) => {
        res.status(200).json({
            status: "ok",
            service: "boreal-staff-server",
        });
    });
    app.use("/api/auth", auth_1.default);
    app.use("/api/v1", routes_1.default);
    app.use((_req, res) => (0, response_1.fail)(res, "not_found", 404));
    return app;
}
function resetOtpStateForTests() {
    // No in-process OTP store is used by this app.
}
const app = createApp();
exports.default = app;
