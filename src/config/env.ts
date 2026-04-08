import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),

  DATABASE_URL: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  TWILIO_VOICE_APP_SID: z.string().optional(),
  CORS_ALLOWED_ORIGINS: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | null = null;

function isTestOrCI() {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.CI === "true" ||
    process.env.CI === "1"
  );
}

export function getEnv(): Env {
  if (cachedEnv) return cachedEnv;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const errors = parsed.error.flatten();

    // 🔴 DO NOT crash in CI or tests
    if (isTestOrCI()) {
      console.warn("ENV VALIDATION FAILED (non-blocking in CI/test):", errors);
      cachedEnv = process.env as Env;
      return cachedEnv;
    }

    // 🔴 Production = fail fast WITHOUT process.exit
    throw new Error(
      "ENV VALIDATION FAILED: " + JSON.stringify(errors, null, 2)
    );
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
