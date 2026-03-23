
import { config } from "@/config";
export const env = {
  NODE_ENV: config.env,
  DATABASE_URL: config.db.url,
  JWT_SECRET: config.jwt.secret,
};
