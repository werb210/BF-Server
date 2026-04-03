"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
exports.resetOtpStateForTests = resetOtpStateForTests;
const cors_1 = __importDefault(require("cors"));
const express_1 = __importDefault(require("express"));
const routes_1 = __importDefault(require("./routes"));
const response_1 = require("./lib/response");
const allowed = [
    "https://www.borealfinancial.ca",
    "https://boreal.financial",
    "https://portal.boreal.financial",
    "https://client.boreal.financial",
];
function createApp() {
    const app = (0, express_1.default)();
    app.disable("x-powered-by");
    app.use(express_1.default.json());
    app.use((0, cors_1.default)({
        origin: (origin, cb) => {
            if (!origin)
                return cb(null, true);
            if (allowed.includes(origin))
                return cb(null, true);
            return cb(new Error("Not allowed"), false);
        },
        credentials: true,
    }));
    app.get("/health", (_req, res) => {
        res.status(200).send("ok");
    });
    app.get("/api/_int/health", (_req, res) => {
        res.json({
            status: "ok",
            uptime: process.uptime(),
        });
    });
    app.use("/api/v1", routes_1.default);
    app.use((_req, res) => (0, response_1.fail)(res, "not_found", 404));
    return app;
}
function resetOtpStateForTests() {
    // No in-process OTP store is used by this app.
}
const app = createApp();
exports.default = app;
