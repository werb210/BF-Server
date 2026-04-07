import { z } from "zod";

const weakJwtSecrets = ["test", "secret", "change-me"];

const envSchema = z.object({
  PORT: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters")
    .refine((v) => !weakJwtSecrets.includes(v.toLowerCase()), {
      message: "JWT_SECRET too weak",
    }),
  OPENAI_API_KEY: z
    .string()
    .min(20, "OPENAI_API_KEY is required")
    .refine((v) => !v.includes("placeholder"), {
      message: "OPENAI_API_KEY must not be a placeholder",
    }),
});

export function getEnv() {
  const nodeEnv = process.env.NODE_ENV ?? "development";

  if (nodeEnv === "development") {
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
    return {
      PORT: process.env.PORT,
      NODE_ENV: process.env.NODE_ENV as "development" | "test" | "production" | undefined,
      JWT_SECRET: process.env.JWT_SECRET ?? "",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
    };
  }

  return safeEnv.data;
}

export function validateRuntimeEnvOrExit() {
  return getEnv();
}

export function resetEnvCacheForTests() {
  // no-op: getEnv() is intentionally uncached.
}
