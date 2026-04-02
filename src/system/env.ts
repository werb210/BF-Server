import { CONFIG } from "./config";

function req(name: string) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`ENV_MISSING_${name}`);
  }
  return v;
}

if (!Number.isFinite(CONFIG.PORT) || CONFIG.PORT <= 0) {
  throw new Error("ENV_INVALID_PORT");
}

if (!["development", "test", "production"].includes(CONFIG.NODE_ENV)) {
  throw new Error("ENV_INVALID_NODE_ENV");
}

if (CONFIG.NODE_ENV === "production") {
  req("JWT_SECRET");
}

export const ENV = {
  PORT: String(CONFIG.PORT),
  NODE_ENV: CONFIG.NODE_ENV,
  DATABASE_URL: CONFIG.DATABASE_URL,
};

export { req };
