import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_PHONE_NUMBER: z.string().min(1),
  SENDGRID_API_KEY: z.string().min(1),
  WEBSITE_URL: z.string().url().optional(),
  PORTAL_URL: z.string().url().optional(),
  CLIENT_URL: z.string().url().optional(),
  FRONTEND_URL: z.string().url().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]),
  GA_ID: z.string().min(1).optional(),
  SENTRY_DSN: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof envSchema>;

let cachedEnv: ServerEnv | null = null;

export type Env = ServerEnv & {
  PORT: string;
  TEST_MODE?: string;
  JWT_REFRESH_SECRET?: string;
  CORS_ALLOWED_ORIGINS?: string;
  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;
  APPINSIGHTS_CONNECTION_STRING?: string;
};

export function validateServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const nodeEnv = process.env.NODE_ENV ?? "development";
  if (nodeEnv !== "production") {
    process.env.NODE_ENV = nodeEnv;
    process.env.DATABASE_URL ||= "postgres://postgres:postgres@localhost:5432/staff_dev";
    process.env.JWT_SECRET ||= "dev-jwt-secret";
    process.env.TWILIO_ACCOUNT_SID ||= "AC00000000000000000000000000000000";
    process.env.TWILIO_AUTH_TOKEN ||= "dev-twilio-token";
    process.env.TWILIO_PHONE_NUMBER ||= "+10000000000";
    process.env.SENDGRID_API_KEY ||= "dev-sendgrid-key";
    process.env.CORS_ALLOWED_ORIGINS ||= "http://localhost:5173";
    process.env.RATE_LIMIT_WINDOW_MS ||= "60000";
    process.env.RATE_LIMIT_MAX ||= "200";
    process.env.APPINSIGHTS_CONNECTION_STRING ||= "InstrumentationKey=dev";
    process.env.JWT_EXPIRES_IN ||= "15m";
    process.env.JWT_REFRESH_EXPIRES_IN ||= "30d";
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missingOrInvalid = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new Error(
      `Invalid server environment configuration: ${missingOrInvalid.join(", ")}`
    );
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

export const ENV: Env = {
  ...validateServerEnv(),
  PORT: process.env.PORT ?? "3000",
  TEST_MODE: process.env.TEST_MODE,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
  APPINSIGHTS_CONNECTION_STRING: process.env.APPINSIGHTS_CONNECTION_STRING,
};

export function isTest(): boolean {
  return process.env.NODE_ENV === "test";
}

// backward compatibility
export const getAuditHistoryEnabled = () => false;
