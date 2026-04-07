"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
exports.resetOtpStateForTests = resetOtpStateForTests;
const crypto_1 = __importDefault(require("crypto"));
const express_1 = __importDefault(require("express"));
const helmet_1 = __importDefault(require("helmet"));
const auth_1 = __importDefault(require("./routes/auth"));
const voice_1 = __importDefault(require("./routes/voice"));
const public_1 = __importDefault(require("./routes/public"));
const routeRegistry_1 = require("./routes/routeRegistry");
const response_1 = require("./lib/response");
const env_1 = require("./config/env");
const routeAlias_1 = __importDefault(require("./middleware/routeAlias"));
const deps_1 = require("./system/deps");
const cors_1 = require("./middleware/cors");
const allowedProductionHosts = ["server.boreal.financial"];
function healthResponse(req, data = {}) {
    return {
        status: "ok",
        data,
        rid: req.rid,
    };
}
function voiceStatusHandler(req, res) {
    return res.json((0, response_1.ok)({}, req.rid));
}
async function callStartHandler(req, res) {
    const { to } = req.body;
    if (!to || typeof to !== "string") {
        return res.status(400).json((0, response_1.fail)("invalid_payload", req.rid));
    }
    try {
        return res.json((0, response_1.ok)({ callId: `call_${Date.now()}`, status: "queued" }, req.rid));
    }
    catch {
        return res.status(500).json((0, response_1.fail)("call_start_failed", req.rid));
    }
}
function createApp() {
    const app = (0, express_1.default)();
    app.use((req, res, next) => {
        const rid = crypto_1.default.randomUUID();
        req.rid = rid;
        req.id = rid;
        res.setHeader("x-request-id", rid);
        next();
    });
    app.use((req, res, next) => {
        res.setHeader("content-type", "application/json");
        next();
    });
    app.use((req, res, next) => {
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("x-frame-options", "DENY");
        res.setHeader("x-xss-protection", "1; mode=block");
        next();
    });
    app.use((req, res, next) => {
        deps_1.deps.metrics.requests = (deps_1.deps.metrics.requests + 1) % Number.MAX_SAFE_INTEGER;
        res.on("finish", () => {
            const entry = {
                level: "info",
                msg: "request",
                method: req.method,
                path: req.path,
                status: res.statusCode,
                rid: req.rid,
            };
            try {
                console.log(JSON.stringify(entry));
            }
            catch {
                // no-op logging fallback
            }
            if (res.statusCode >= 400) {
                deps_1.deps.metrics.errors = (deps_1.deps.metrics.errors + 1) % Number.MAX_SAFE_INTEGER;
            }
        });
        next();
    });
    app.use((req, res, next) => {
        if (req.path.startsWith("/api/public")) {
            return res.status(410).json((0, response_1.fail)("LEGACY_ROUTE_DISABLED", req.rid));
        }
        return next();
    });
    app.use(cors_1.corsMiddleware);
    app.get("/health", (req, res) => {
        return res.status(200).json(healthResponse(req));
    });
    app.get("/ready", (req, res) => {
        if (!deps_1.deps.db.ready) {
            return res.status(503).json((0, response_1.fail)("not_ready", req.rid));
        }
        return res.status(200).json(healthResponse(req));
    });
    app.get("/api/_int/health", (req, res) => {
        res.json(healthResponse(req, { uptime: process.uptime() }));
    });
    app.use((req, res, next) => {
        if (req.path === "/" ||
            req.path === "/health" ||
            req.path === "/ready" ||
            req.path === "/metrics" ||
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
            return res.status(403).json((0, response_1.fail)("Forbidden", req.rid));
        }
        return next();
    });
    app.disable("x-powered-by");
    app.set("trust proxy", 1);
    app.use((0, helmet_1.default)());
    app.use(express_1.default.json());
    app.use(routeAlias_1.default);
    app.get("/", (_req, res) => {
        res.status(200).json(healthResponse(_req));
    });
    const apiHealthHandler = (req, res) => {
        return res.status(200).json(healthResponse(req, {
            server: "ok",
            db: deps_1.deps.db.ready ? "ok" : "degraded",
            twilio: process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE ? "configured" : "missing",
        }));
    };
    app.get("/api/health", apiHealthHandler);
    app.get("/api/v1/health", apiHealthHandler);
    app.get("/metrics", (req, res) => {
        return res.status(200).json((0, response_1.ok)({ requests: deps_1.deps.metrics.requests, errors: deps_1.deps.metrics.errors }, req.rid));
    });
    app.get("/metrics/reset", (req, res) => {
        deps_1.globalState.metrics.requests = 0;
        deps_1.globalState.metrics.errors = 0;
        return res.json((0, response_1.ok)({}, req.rid));
    });
    app.use("/api/auth", auth_1.default);
    app.use("/api/v1/auth", auth_1.default);
    app.use("/api/voice", voice_1.default);
    app.use("/api/v1/voice", voice_1.default);
    app.post("/api/voice/status", voiceStatusHandler);
    app.post("/api/v1/voice/status", voiceStatusHandler);
    app.post("/api/call/start", callStartHandler);
    app.post("/api/v1/call/start", callStartHandler);
    {
        function limiter(req, res, next) {
            const now = Math.floor(Date.now() / 1000);
            if (deps_1.globalState.rateLimit.window !== now) {
                deps_1.globalState.rateLimit.window = now;
                deps_1.globalState.rateLimit.count = 0;
            }
            deps_1.globalState.rateLimit.count += 1;
            if (deps_1.globalState.rateLimit.count > 100) {
                res.setHeader("retry-after", "1");
                return res.status(429).json((0, response_1.fail)("Too many requests", req.rid));
            }
            return next();
        }
        app.use("/api/v1/public/test", limiter);
        app.use("/api/v1/public", public_1.default);
    }
    (0, routeRegistry_1.registerApiRouteMounts)(app);
    app.use((req, res) => {
        res.status(404).json((0, response_1.fail)("not_found", req.rid));
    });
    app.use((err, req, res, _next) => {
        void err;
        return res.status(500).json({
            status: "error",
            error: "internal_error",
            rid: req.rid,
        });
    });
    return app;
}
function resetOtpStateForTests() {
    // OTP persistence is external/no-op for this router.
}
