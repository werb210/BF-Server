import { z } from "zod";

const schema = z.object({
  PORT: z.string().optional(),
  NODE_ENV: z.string().optional(),
  JWT_SECRET: z.string().optional(),
});

let cached: z.infer<typeof schema> | null = null;

export function getEnv() {
  if (!cached) {
    cached = schema.parse({
      PORT: process.env.PORT,
      NODE_ENV: process.env.NODE_ENV,
      JWT_SECRET:
        process.env.JWT_SECRET ||
        (process.env.NODE_ENV === "test" ? "test-secret" : undefined),
    });
  }
  return cached;
}
