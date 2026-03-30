"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const auth_routes_1 = __importDefault(require("../routes/auth.routes"));
function createServer() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use((0, cookie_parser_1.default)());
    app.use((0, cors_1.default)({
        origin: [
            "https://portal.boreal.financial",
            "https://client.boreal.financial",
            "http://localhost:5173"
        ],
        credentials: true
    }));
    app.use((req, _res, next) => {
        console.log(`${req.method} ${req.path}`);
        next();
    });
    app.get("/health", (_req, res) => {
        res.json({ status: "ok" });
    });
    app.use("/api/auth", auth_routes_1.default);
    return app;
}
