import { z } from "zod";

if (!process.env.DATABASE_URL) throw new Error("MISSING_DATABASE_URL");
if (!process.env.PORT) throw new Error("MISSING_PORT");

const base = {
  PORT: z.string().default("8080"),
};

const prod = {
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  TWILIO_ACCOUNT_SID: z.string().min(1),
  TWILIO_AUTH_TOKEN: z.string().min(1),
  TWILIO_VERIFY_SERVICE_SID: z.string().min(1),
};

const dev = {
  DATABASE_URL: z.string().default(""),
  JWT_SECRET: z.string().default("test-secret-123456"),
  TWILIO_ACCOUNT_SID: z.string().default("test"),
  TWILIO_AUTH_TOKEN: z.string().default("test"),
  TWILIO_VERIFY_SERVICE_SID: z.string().default("test"),
};

const schema =
  process.env.NODE_ENV === "production"
    ? z.object({ ...base, ...prod })
    : z.object({ ...base, ...dev });

export const ENV = schema.parse(process.env);
