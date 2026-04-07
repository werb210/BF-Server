"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnv = getEnv;
exports.validateRuntimeEnvOrExit = validateRuntimeEnvOrExit;
exports.resetEnvCacheForTests = resetEnvCacheForTests;
const zod_1 = require("zod");
const weakJwtSecrets = ["test", "secret", "test-secret", "change-me"];
const envSchema = zod_1.z.object({
    PORT: zod_1.z.string().optional(),
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).optional(),
    JWT_SECRET: zod_1.z
        .string()
        .min(32, "JWT_SECRET must be at least 32 characters")
        .refine((v) => !weakJwtSecrets.includes(v.toLowerCase()), {
        message: "JWT_SECRET must not be a known weak value",
    }),
    OPENAI_API_KEY: zod_1.z
        .string()
        .min(20, "OPENAI_API_KEY is required")
        .refine((v) => !v.includes("placeholder"), {
        message: "OPENAI_API_KEY must not be a placeholder",
    }),
});
let cached;
function getEnv() {
    if (!cached) {
        const nodeEnv = process.env.NODE_ENV ?? "development";
        if (nodeEnv !== "production") {
            process.env.JWT_SECRET = process.env.JWT_SECRET ?? "test-secret-32-characters-minimum!!";
            process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-openai-key-1234567890";
        }
        const safeEnv = envSchema.safeParse({
            PORT: process.env.PORT,
            NODE_ENV: process.env.NODE_ENV,
            JWT_SECRET: process.env.JWT_SECRET,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        });
        if (!safeEnv.success) {
            console.error("ENV VALIDATION FAILED:", safeEnv.error.flatten());
            cached = {
                PORT: process.env.PORT,
                NODE_ENV: process.env.NODE_ENV,
                JWT_SECRET: process.env.JWT_SECRET ?? "",
                OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
            };
        }
        else {
            cached = safeEnv.data;
        }
    }
    return cached;
}
function validateRuntimeEnvOrExit() {
    return getEnv();
}
function resetEnvCacheForTests() {
    cached = undefined;
}
