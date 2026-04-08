"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateEnv = validateEnv;
function validateEnv() {
    const required = [
        "DATABASE_URL",
        "JWT_SECRET",
        "OPENAI_API_KEY"
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing env vars: ${missing.join(", ")}`);
    }
}
