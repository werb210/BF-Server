import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.string().default("3000"),
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string(),
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

export const env = envSchema.parse(process.env);
