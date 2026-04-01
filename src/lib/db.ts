import { Pool } from "pg";

const isTest = process.env.NODE_ENV === "test";

let pool: Pool | null = null;

export function getDb() {
  if (isTest) {
    return {
      query: async () => ({ rows: [], rowCount: 0 }),
    };
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
  }

  return pool;
}

export async function queryDb(query: string, params: any[] = []) {
  return getDb().query(query, params);
}

export async function getPrisma() {
  throw new Error("Prisma not implemented");
}
