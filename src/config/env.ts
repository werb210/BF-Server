export type EnvConfig = {
  NODE_ENV: string;
  PORT: string;

  TEST_MODE: boolean;

  JWT_SECRET: string;
  JWT_REFRESH_SECRET: string;

  CLIENT_URL: string;
  PORTAL_URL: string;
};

export const ENV: EnvConfig = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: process.env.PORT || "4000",

  TEST_MODE: process.env.TEST_MODE === "true",

  JWT_SECRET: process.env.JWT_SECRET || "dev_jwt_secret",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "dev_refresh_secret",

  CLIENT_URL: process.env.CLIENT_URL || "http://localhost:5173",
  PORTAL_URL: process.env.PORTAL_URL || "http://localhost:3000",
};

export const isTest = ENV.TEST_MODE || ENV.NODE_ENV === "test";
