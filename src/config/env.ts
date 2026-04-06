import { z } from "zod";

export const env = z.object({
  PORT: z.string().default("8080"),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  JWT_SECRET: z.string().min(32),
}).parse(process.env);

export function getEnv() {
  return env;
}

export function validateRuntimeEnvOrExit() {
  return env;
}

export function resetEnvCacheForTests() {
  // no-op: env is parsed eagerly
}
