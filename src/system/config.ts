import { config } from "../config";

export const CONFIG = {
  NODE_ENV: config.env,
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX ?? 100),
};
