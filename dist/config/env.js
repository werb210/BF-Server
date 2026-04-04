"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnv = getEnv;
exports.validateRuntimeEnvOrExit = validateRuntimeEnvOrExit;
exports.resetEnvCacheForTests = resetEnvCacheForTests;
const zod_1 = require("zod");
const envSchema = zod_1.z.object({
    PORT: zod_1.z.string().optional(),
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).optional(),
    JWT_SECRET: zod_1.z
        .string()
        .min(32, "JWT_SECRET must be at least 32 chars")
        .refine((value) => !value.includes("REPLACE"), { message: "invalid jwt secret" }),
    OPENAI_API_KEY: zod_1.z.string().min(10, "OPENAI_API_KEY is required"),
});
let cached;
function getEnv() {
    if (!cached) {
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
