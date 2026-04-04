"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
function str(name, def) {
    const v = process.env[name] ?? def;
    if (v === undefined) {
        throw new Error(`ENV_MISSING_${name}`);
    }
    return v;
}
function num(name, def) {
    const v = process.env[name];
    return v ? Number(v) : def;
}
exports.CONFIG = {
    PORT: num("PORT", 8080),
    NODE_ENV: str("NODE_ENV", "production"),
    DATABASE_URL: process.env.DATABASE_URL || "",
    RATE_LIMIT: num("RATE_LIMIT", 100),
    RATE_WINDOW_MS: num("RATE_WINDOW_MS", 60000),
    REQUEST_TIMEOUT_MS: num("REQUEST_TIMEOUT_MS", 15000),
    CORS_ALLOWED_ORIGINS: str("CORS_ALLOWED_ORIGINS", "https://staff.boreal.financial"),
    STRICT_API: str("STRICT_API", "true"),
};
