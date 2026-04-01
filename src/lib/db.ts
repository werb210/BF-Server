import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function queryDb(query: string, params: any[] = []) {
  return pool.query(query, params);
}

export function getDb() {
  return pool;
}

export async function getPrisma() {
  throw new Error("Prisma not implemented");
}
