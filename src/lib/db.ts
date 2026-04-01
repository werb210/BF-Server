import { AsyncLocalStorage } from "node:async_hooks";

import { Pool, PoolClient } from "pg";
import { getTestDb } from "./db.test";

let pool: Pool | null = null;
const transactionContext = new AsyncLocalStorage<boolean>();

type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<any>;
};

export function getDb() {
  if (process.env.NODE_ENV === "test" && process.env.DATABASE_URL) {
    throw new Error("Invalid config: DATABASE_URL must not be set in test mode");
  }

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

function validateQueryInputs(sql: string, params?: unknown[]) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new Error("queryDb requires a non-empty SQL query string");
  }

  if (sql.includes("undefined")) {
    throw new Error("queryDb SQL must not contain undefined");
  }

  if (typeof params !== "undefined" && !Array.isArray(params)) {
    throw new Error("queryDb params must be an array when provided");
  }

  if (params && params.some((param) => typeof param === "undefined")) {
    throw new Error("queryDb params must not include undefined values");
  }
}

async function executeQuery(queryable: Queryable, sql: string, params?: unknown[]) {
  validateQueryInputs(sql, params);
  return queryable.query(sql, params);
}

async function runQuery(queryable: Queryable, sql: string, params?: unknown[]) {
  if (transactionContext.getStore()) {
    return executeQuery(queryable, sql, params);
  }

  return withDbTransaction(async () => {
    return transactionContext.run(true, async () => executeQuery(queryable, sql, params));
  });
}

export async function queryDb(query: string, params?: unknown[]) {
  return runQuery(getDb(), query, params);
}

export async function withDbTransaction<T>(fn: (query: typeof queryDb) => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV === "test") {
    const db = getDb();
    await executeQuery(db, "BEGIN");
    try {
      const result = await transactionContext.run(true, async () => fn(queryDb));
      return result;
    } finally {
      await executeQuery(db, "ROLLBACK");
    }
  }

  const db = getDb() as Pool;
  const client: PoolClient = await db.connect();
  const transactionalQuery = (query: string, params?: unknown[]) => executeQuery(client, query, params);

  await transactionalQuery("BEGIN");
  try {
    return await transactionContext.run(true, async () => fn(transactionalQuery as typeof queryDb));
  } finally {
    await transactionalQuery("ROLLBACK");
    client.release();
  }
}

export async function getPrisma() {
  throw new Error("Prisma not implemented");
}
