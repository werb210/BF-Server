import { z } from "zod";

const envSchema = z.object({
  PORT: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 chars")
    .refine((value) => !value.includes("REPLACE"), { message: "invalid jwt secret" }),
  OPENAI_API_KEY: z.string().min(10, "OPENAI_API_KEY is required"),
});

let cached: z.infer<typeof envSchema> | undefined;

export function getEnv() {
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
        NODE_ENV: process.env.NODE_ENV as "development" | "test" | "production" | undefined,
        JWT_SECRET: process.env.JWT_SECRET ?? "",
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
      };
    } else {
      cached = safeEnv.data;
    }
  }

  return cached;
}

export function validateRuntimeEnvOrExit() {
  const required = [
    "DATABASE_URL",
    "JWT_SECRET",
    "OPENAI_API_KEY",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      console.error(`❌ Missing env: ${key}`);
      process.exit(1);
    }
  }

  return getEnv();
}

export function resetEnvCacheForTests() {
  cached = undefined;
}
