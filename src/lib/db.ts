import { Pool, PoolClient } from "pg";
import { getTestDb } from "./db.test";

let pool: Pool | null = null;

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<any>;
};

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

function validateQueryInputs(query: string, params?: unknown[]) {
  if (!query || query.trim().length === 0) {
    throw new Error("queryDb requires a non-empty SQL query string");
  }

  if (params && params.some((param) => typeof param === "undefined")) {
    throw new Error("queryDb params must not include undefined values");
  }
}

async function runQuery(queryable: Queryable, query: string, params?: unknown[]) {
  validateQueryInputs(query, params);
  return queryable.query(query, params);
}

export async function queryDb(query: string, params?: unknown[]) {
  return runQuery(getDb(), query, params);
}

export async function withDbTransaction<T>(fn: (query: typeof queryDb) => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV === "test") {
    await queryDb("BEGIN");
    try {
      const result = await fn(queryDb);
      return result;
    } finally {
      await queryDb("ROLLBACK");
    }
  }

  const db = getDb() as Pool;
  const client: PoolClient = await db.connect();
  const transactionalQuery = (query: string, params?: unknown[]) => runQuery(client, query, params);

  await transactionalQuery("BEGIN");
  try {
    return await fn(transactionalQuery as typeof queryDb);
  } finally {
    await transactionalQuery("ROLLBACK");
    client.release();
  }
}

export async function getPrisma() {
  throw new Error("Prisma not implemented");
}
