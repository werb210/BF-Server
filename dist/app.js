"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
exports.resetOtpStateForTests = resetOtpStateForTests;
const express_1 = __importDefault(require("express"));
const auth_1 = __importDefault(require("./routes/auth"));
const routes_1 = __importDefault(require("./routes"));
const response_1 = require("./lib/response");
const env_1 = require("./config/env");
const routeRegistry_1 = require("./routes/routeRegistry");
const cors_1 = require("./middleware/cors");
const allowedProductionHosts = ["server.boreal.financial"];
function createApp() {
    const app = (0, express_1.default)();
    app.options("*", (req, res) => {
        const origin = req.headers.origin;
        if (!origin) {
            return res.status(410).json({
                status: "error",
                error: "LEGACY_ROUTE_DEPRECATED",
            });
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        return res.sendStatus(204);
    });
    app.use(cors_1.corsMiddleware);
    app.get("/health", (_req, res) => {
        res.status(200).json({
            status: "ok",
        });
    });
    app.get("/ready", (_req, res) => {
        res.status(200).json({
            status: "ready",
        });
    });
    app.get("/api/health", async (_req, res) => {
        let dbStatus = "ok";
        try {
            const { initDb } = require("./db/init");
            await initDb();
        }
        catch (_err) {
            dbStatus = "fail";
        }
        const statusCode = dbStatus === "ok" ? 200 : 503;
        return res.status(statusCode).json({
            status: dbStatus === "ok" ? "ok" : "error",
            data: {
                db: dbStatus,
            },
        });
    });
    app.get("/api/_int/health", (_req, res) => {
        res.json({
            status: "ok",
            uptime: process.uptime(),
        });
    });
    app.use((req, res, next) => {
        if (req.path === "/" ||
            req.path === "/health" ||
            req.path === "/ready" ||
            req.path === "/api/health" ||
            req.path === "/api/_int/health") {
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
    app.get("/", (_req, res) => {
        res.status(200).send("OK");
    });
    app.use("/api/auth", auth_1.default);
    app.use("/api/v1", routes_1.default);
    (0, routeRegistry_1.registerApiRouteMounts)(app);
    app.use((_req, res) => (0, response_1.fail)(res, "not_found", 404));
    app.use((err, _req, res, next) => {
        if (res.headersSent) {
            return next(err);
        }
        console.error("GLOBAL ERROR:", err);
        return res.status(500).json({
            status: "error",
            error: err?.message || "INTERNAL_SERVER_ERROR",
        });
    });
    return app;
}
function resetOtpStateForTests() {
    // No in-process OTP store is used by this app.
}
const app = createApp();
if (require.main === module) {
    const port = Number(process.env.PORT) || 8080;
    app.listen(port, "0.0.0.0", () => {
        console.log(`SERVER STARTED ON ${port}`);
    });
}
exports.default = app;
