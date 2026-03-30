"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_routes_1 = __importDefault(require("../routes/auth.routes"));
const applications_routes_1 = __importDefault(require("../routes/applications.routes"));
const documents_1 = __importDefault(require("../routes/documents"));
function createServer() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use((0, cors_1.default)({
        origin: [
            "https://portal.boreal.financial",
            "https://client.boreal.financial",
            "http://localhost:3000",
            "http://localhost:5173",
        ],
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false,
    }));
    app.use((req, _res, next) => {
        console.log(`[REQ] ${req.method} ${req.url}`);
        next();
    });
    const otpLimiter = (0, express_rate_limit_1.default)({
        windowMs: 60 * 1000,
        max: 5,
    });
    app.get("/health", (_req, res) => {
        res.status(200).send("ok");
    });
    app.use("/api/auth/otp", otpLimiter);
    app.use("/api/auth", auth_routes_1.default);
    app.use("/api/applications", applications_routes_1.default);
    app.use("/api/documents", documents_1.default);
    app.use((err, _req, res, _next) => {
        console.error("[ERROR]", err);
        res.status(500).json({
            error: "internal_error",
        });
    });
    return app;
}
exports.default = createServer;
