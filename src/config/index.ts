import { env } from "./env";

const nodeEnv = env.NODE_ENV;
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://USER:PASSWORD@HOST:5432/dbname";
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

export const config = {
  env: nodeEnv,
  isProd: nodeEnv === "production",
  isTest: nodeEnv === "test",
  port: Number(env.PORT),
  jwtSecret: env.JWT_SECRET,
  db: {
    url: databaseUrl,
    ssl: nodeEnv === "production",
  },
  redis: {
    url: redisUrl,
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID ?? "",
    phoneNumber: process.env.TWILIO_PHONE_NUMBER ?? process.env.TWILIO_PHONE ?? "",
  },
};

export function assertEnv() {
  return env;
}

export default config;
