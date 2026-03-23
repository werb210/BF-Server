import dotenv from 'dotenv';

dotenv.config();

type Env = {
  NODE_ENV: string;
  PORT: string;
  DATABASE_URL: string;

  // Added missing fields used across codebase
  TEST_MODE?: string;

  JWT_SECRET?: string;
  JWT_REFRESH_SECRET?: string;

  CLIENT_URL?: string;
  PORTAL_URL?: string;

  CORS_ALLOWED_ORIGINS?: string;

  RATE_LIMIT_WINDOW_MS?: string;
  RATE_LIMIT_MAX?: string;

  APPINSIGHTS_CONNECTION_STRING?: string;

  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;

  SENDGRID_API_KEY?: string;
};

const requiredVars = ['DATABASE_URL'];

for (const key of requiredVars) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

export const ENV: Env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || '3000',
  DATABASE_URL: process.env.DATABASE_URL!,

  TEST_MODE: process.env.TEST_MODE,

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,

  CLIENT_URL: process.env.CLIENT_URL,
  PORTAL_URL: process.env.PORTAL_URL,

  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,

  RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,

  APPINSIGHTS_CONNECTION_STRING: process.env.APPINSIGHTS_CONNECTION_STRING,

  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,

  SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
};
