import { z } from "zod";

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_SECRET: z.string().min(10),
    OPENAI_API_KEY: z.string().min(1),
    TWILIO_ACCOUNT_SID: z.string().min(1),
    TWILIO_AUTH_TOKEN: z.string().min(1),
    TWILIO_PHONE: z.string().min(1),
    PORT: z.string().regex(/^\d+$/).optional(),
    API_BASE_URL: z.string().min(1).optional(),
    PUBLIC_BASE_URL: z.string().min(1).optional(),
    CLIENT_BASE_URL: z.string().min(1).optional(),
    LOG_LEVEL: z.string().min(1).optional(),
    INSTANCE_ID: z.string().min(1).optional(),
    HOSTNAME: z.string().min(1).optional(),
    APPINSIGHTS_CONNECTION_STRING: z.string().min(1).optional(),
    APPLICATIONINSIGHTS_CONNECTION_STRING: z.string().min(1).optional(),
    API_V1_ALLOW_UNFROZEN: z.enum(["true", "false"]).optional(),
    RUN_DB_MIGRATIONS: z.enum(["true", "false"]).optional(),
    TWILIO_API_KEY: z.string().min(1).optional(),
    TWILIO_API_SECRET: z.string().min(1).optional(),
    TWILIO_VOICE_APP_SID: z.string().min(1).optional(),
    OTP_HASH_SECRET: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_REDIRECT_URI: z.string().min(1).optional(),
    GOOGLE_SHEETS_REFRESH_TOKEN: z.string().min(1).optional(),
  })
  .passthrough();

export type ParsedEnv = z.infer<typeof EnvSchema>;
