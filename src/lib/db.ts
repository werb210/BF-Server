import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/postgres";

export const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

export async function testDb() {
  try {
    await pool.query("SELECT 1");
    console.log("DB OK");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("DB FAILED", message);
    throw err;
  }
}
