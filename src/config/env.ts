import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  return process.env[name] || fallback;
}

export const ENV = {
  PORT: Number(process.env.PORT || 8080),

  DATABASE_URL: required("DATABASE_URL"),

  JWT_SECRET: required("JWT_SECRET"),
  JWT_REFRESH_SECRET: required("JWT_REFRESH_SECRET"),

  CLIENT_URL: required("CLIENT_URL"),
  PORTAL_URL: required("PORTAL_URL"),

  TWILIO_ACCOUNT_SID: optional("TWILIO_ACCOUNT_SID"),
  TWILIO_API_KEY: optional("TWILIO_API_KEY"),
  TWILIO_API_SECRET: optional("TWILIO_API_SECRET"),
  TWILIO_VERIFY_SERVICE_SID: optional("TWILIO_VERIFY_SERVICE_SID"),

  TEST_MODE: process.env.TEST_MODE === "true"
};
