import { Pool } from "pg";
import { config } from "../config";

export const dbClient = new Pool({
  connectionString: config.db.url,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export default dbClient;
