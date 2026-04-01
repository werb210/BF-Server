import { Pool } from "pg";
import { getTestDb } from "./db.test";

let pool: Pool | null = null;

export function getDb() {
  if (process.env.NODE_ENV === "test") {
    return getTestDb();
  }

  if (!pool) {
    if (!process.env.DATABASE_URL) {
      console.error("Missing DATABASE_URL");
      process.exit(1);
    }

    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  return pool;
}

export async function queryDb(query: string, params?: any[]) {
  const db = getDb();
  return db.query(query, params);
}

export async function getPrisma() {
  throw new Error("Prisma not implemented");
}
