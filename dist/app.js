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
const response_1 = require("./lib/response");
function createApp() {
    const app = (0, express_1.default)();
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
    app.get("/health", (_req, res) => {
        res.status(200).send("healthy");
    });
    app.get("/api/_int/health", (_req, res) => {
        res.json({
            status: "ok",
            uptime: process.uptime(),
        });
    });
    app.use("/api/auth", require("./routes/auth").default);
    app.use("/api/v1", routes_1.default);
    app.use((_req, res) => (0, response_1.fail)(res, "not_found", 404));
    return app;
}
function resetOtpStateForTests() {
    // No in-process OTP store is used by this app.
}
const app = createApp();
exports.default = app;
