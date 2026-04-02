import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.string().default("8080"),
  DATABASE_URL: z.string().min(1).default("postgres://localhost/test"),
  JWT_SECRET: z.string().min(1).default("test-jwt-secret"),
});

export const env = schema.parse(process.env);
export const ENV = env as typeof env & Record<string, string>;
