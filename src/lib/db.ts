import { Pool } from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { getTestDb } from "./db.test";

type Queryable = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) => Promise<any>;
};

let pool: Pool | null = null;

function validateQueryInputs(sql: string, params?: unknown[]) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new Error("runQuery requires a non-empty SQL query string");
  }

  if (sql.includes("undefined")) {
    throw new Error("runQuery SQL must not contain undefined");
  }

  if (typeof params !== "undefined" && !Array.isArray(params)) {
    throw new Error("runQuery params must be an array when provided");
  }

  if (params && params.some((param) => typeof param === "undefined")) {
    throw new Error("runQuery params must not include undefined values");
  }
}

function getQueryable(): Queryable {
  if (process.env.NODE_ENV === "test") {
    return getTestDb();
  }

  if (!process.env.DATABASE_URL) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }

  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }

  return pool;
}

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  validateQueryInputs(sql, params);
  return getQueryable().query<T>(sql, params);
}

export async function getPrisma() {
  throw new Error("Prisma not implemented");
}
