import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.string().default("3000"),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/staff_dev"),
  JWT_SECRET: z.string().default("dev-jwt-secret"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  STORAGE_PROVIDER: z.string().optional(),
  SERVICE_NAME: z.string().default("bf-server"),
  LOG_LEVEL: z.string().optional(),
  CLIENT_URL: z.string().optional(),
  PORTAL_URL: z.string().optional(),
  WEBSITE_URL: z.string().optional(),
  PRINT_ROUTES: z.string().optional(),
});

const envSource =
  process.env.NODE_ENV === "test"
    ? {
        DATABASE_URL:
          process.env.DATABASE_URL ||
          "postgres://test:test@localhost:5432/test",
        JWT_SECRET: process.env.JWT_SECRET || "test-secret",
        JWT_REFRESH_SECRET:
          process.env.JWT_REFRESH_SECRET || "test-refresh",
        ...process.env,
      }
    : process.env;

export const env = envSchema.parse(envSource);
