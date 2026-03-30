"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
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
            "http://localhost:4173",
            "http://localhost:3000"
        ],
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: false
    }));
    app.use((req, _res, next) => {
        console.log(`${req.method} ${req.path}`);
        next();
    });
    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });
    app.use("/api/auth", auth_routes_1.default);
    app.use("/api/application", applications_routes_1.default);
    app.use("/api/documents", documents_1.default);
    return app;
}
