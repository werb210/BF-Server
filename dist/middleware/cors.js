"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.corsMiddleware = void 0;
const cors_1 = __importDefault(require("cors"));
const allowedProductionOrigins = [
    "https://boreal.financial",
    "https://www.boreal.financial",
    "https://client.boreal.financial",
    "https://staff.boreal.financial",
    "https://server.boreal.financial",
];
function getEnvOrigins() {
    const raw = process.env.CORS_ALLOWED_ORIGINS;
    if (!raw)
        return [];
    return raw
        .split(",")
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
}
function isAllowedOrigin(origin, nodeEnv) {
    const configuredOrigins = getEnvOrigins();
    if (allowedProductionOrigins.includes(origin) || configuredOrigins.includes(origin)) {
        return true;
    }
    if (nodeEnv !== "production") {
        return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    }
    return false;
}
exports.corsMiddleware = (0, cors_1.default)((req, callback) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    const NODE_ENV = process.env.NODE_ENV;
    if (!origin) {
        return callback(null, { origin: false, credentials: false });
    }
    if (isAllowedOrigin(origin, NODE_ENV)) {
        return callback(null, { origin: true, credentials: true });
    }
    return callback(new Error(`CORS blocked: ${origin}`), {
        origin: false,
        credentials: false,
    });
});
