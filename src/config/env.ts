import { z } from "zod";

const schema = z.object({
  PORT: z.string().default("8080"),
  JWT_SECRET: z.string().min(10),
  NODE_ENV: z.enum(["development", "test", "production"]),
});

let cached: z.infer<typeof schema> | null = null;

export function getEnv() {
  if (!cached) {
    const raw = {
      PORT: process.env.PORT || "8080",
      JWT_SECRET:
        process.env.JWT_SECRET ||
        (process.env.NODE_ENV === "test"
          ? "test-secret-123456"
          : undefined),
      NODE_ENV: process.env.NODE_ENV || "development",
    };

    cached = schema.parse(raw);
  }
  return cached;
}
