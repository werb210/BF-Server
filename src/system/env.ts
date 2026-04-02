import { getEnv } from "../config/env";

export function validateEnv() {
  if (!process.env.PORT) throw new Error("MISSING_PORT");
  getEnv();

  if (process.env.NODE_ENV !== 'test' && !process.env.DB_URL) {
    throw new Error('MISSING_DB_URL');
  }
}
