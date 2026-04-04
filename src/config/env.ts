import { z } from "zod";

const schema = z.object({
  PORT: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 chars")
    .refine((value) => !value.includes("REPLACE_"), "JWT_SECRET contains insecure placeholder text"),
  OPENAI_API_KEY: z.string().min(10, "OPENAI_API_KEY is required"),
});

let cached: z.infer<typeof schema> | undefined;

export function getEnv() {
  if (!cached) {
    cached = schema.parse({
      PORT: process.env.PORT,
      NODE_ENV: process.env.NODE_ENV,
      JWT_SECRET: process.env.JWT_SECRET,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    });
  }

  return cached;
}

export function resetEnvCacheForTests() {
  cached = undefined;
}
