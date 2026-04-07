"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertEnv = assertEnv;
function assertEnv() {
    var _a, _b, _c;
    const nodeEnv = process.env.NODE_ENV ?? "development";
    const isTestEnv = nodeEnv !== "production" ||
        process.env.VITEST === "true" ||
        process.env.CI === "true";
    if (isTestEnv) {
        (_a = process.env).JWT_SECRET || (_a.JWT_SECRET = "test-secret");
        (_b = process.env).OPENAI_API_KEY || (_b.OPENAI_API_KEY = "test-key");
        (_c = process.env).PORT || (_c.PORT = "3000");
        return;
    }
    const required = ["JWT_SECRET", "PORT", "OPENAI_API_KEY"];
    for (const key of required) {
        if (!process.env[key]) {
            throw new Error(`Missing env var: ${key}`);
        }
    }
}
