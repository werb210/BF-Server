import { config } from "../config";

export function validateStartup() {
  if (!config.auth.jwtSecret) {
    throw new Error("Missing JWT secret");
  }

  if (!config.db.url && !config.db.skip) {
    throw new Error("Missing DATABASE_URL");
  }
}
