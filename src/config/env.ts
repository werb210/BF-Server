import dotenv from "dotenv";

dotenv.config();

const isTest = process.env.NODE_ENV === 'test';

function required(value: string | undefined, name: string): string {
  if (!value) {
    if (isTest) return 'test';
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  return process.env[name] || fallback;
}

export const ENV = {
  PORT: Number(process.env.PORT || 8080),

  DATABASE_URL: required(process.env.DATABASE_URL, "DATABASE_URL"),

  JWT_SECRET: required(process.env.JWT_SECRET, "JWT_SECRET"),
  JWT_REFRESH_SECRET: required(process.env.JWT_REFRESH_SECRET, "JWT_REFRESH_SECRET"),

  CLIENT_URL: required(process.env.CLIENT_URL, "CLIENT_URL"),
  PORTAL_URL: required(process.env.PORTAL_URL, "PORTAL_URL"),

  TWILIO_ACCOUNT_SID: optional("TWILIO_ACCOUNT_SID"),
  TWILIO_API_KEY: optional("TWILIO_API_KEY"),
  TWILIO_API_SECRET: optional("TWILIO_API_SECRET"),
  TWILIO_VERIFY_SERVICE_SID: optional("TWILIO_VERIFY_SERVICE_SID"),

  TEST_MODE: process.env.TEST_MODE === "true"
};
