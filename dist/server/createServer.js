"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createServer = createServer;
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const auth_1 = require("../middleware/auth");
const errorHandler_1 = require("../middleware/errorHandler");
const response_1 = require("../lib/response");
const auth_routes_1 = __importDefault(require("../routes/auth.routes"));
const token_1 = __importDefault(require("../routes/telephony/token"));
const application_1 = __importDefault(require("../routes/application"));
const documents_1 = __importDefault(require("../routes/documents"));
const crm_1 = __importDefault(require("../routes/crm"));
function createServer() {
    const app = (0, express_1.default)();
    // MUST BE FIRST
    app.get("/health", (_req, res) => {
        res.status(200).send("OK");
    });
    app.use(express_1.default.json({ limit: "1mb" }));
    app.use(express_1.default.urlencoded({ limit: "1mb", extended: true }));
    app.use((0, cors_1.default)({
        origin: (origin, callback) => callback(null, origin ?? true),
        credentials: true,
        optionsSuccessStatus: 200,
    }));
    app.options("*", (0, cors_1.default)({
        origin: (origin, callback) => callback(null, origin ?? true),
        credentials: true,
        optionsSuccessStatus: 200,
    }));
    app.get("/", (_req, res) => res.status(200).send("Server is running"));
    app.use("/auth", auth_routes_1.default);
    app.use("/telephony", auth_1.auth, token_1.default);
    app.use("/crm", auth_1.auth, crm_1.default);
    app.use("/applications", application_1.default);
    app.use("/documents", documents_1.default);
    app.use(errorHandler_1.errorHandler);
    app.use((_, res) => (0, response_1.fail)(res, "not_found", 404));
    const requiredRoutes = ["/health", "/auth", "/telephony", "/crm", "/applications"];
    const stack = (app._router?.stack ?? []);
    for (const route of requiredRoutes) {
        const mounted = stack.some((layer) => {
            if (layer.route?.path === route) {
                return true;
            }
            if (layer.name === "router" && layer.regexp) {
                return layer.regexp.toString().includes(route.replace("/", "\\/"));
            }
            return false;
        });
        if (!mounted) {
            throw new Error(`MISSING_ROUTE: ${route}`);
        }
    }
    return app;
}
