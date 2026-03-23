import { Pool } from "pg";
import { config } from "@/config";

export const dbClient = new Pool({
  connectionString: config.db.url,
});

export default dbClient;
