import * as dbProd from "./db.prod";
import type { QueryResult, QueryResultRow } from "pg";
import { deps } from "./system/deps";
import { requireDb } from "./system/requireDb";

const dbImpl = dbProd;

export const {
  pool,
  db,
  fetchClient,
  assertPoolHealthy,
  checkDb,
  warmUpDatabase,
  fetchInstrumentedClient,
  setDbTestPoolMetricsOverride,
  setDbTestFailureInjection,
  clearDbTestFailureInjection,
} = dbImpl;

type Queryable = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]) => Promise<QueryResult<T>>;
};

export function getDb() {
  requireDb();
  return pool;
}

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  queryable: Queryable,
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  requireDb();
  try {
    return await dbImpl.runQuery<T>(queryable, text, params);
  } catch {
    throw new Error("DB_QUERY_FAILED");
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  requireDb();
  try {
    return await (dbImpl.query as unknown as (t: string, p?: any[]) => Promise<QueryResult<T>>)(text, params);
  } catch {
    throw new Error("DB_QUERY_FAILED");
  }
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  requireDb();
  try {
    return await dbImpl.dbQuery<T>(text, params);
  } catch {
    throw new Error("DB_QUERY_FAILED");
  }
}

export async function safeQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: any[],
): Promise<QueryResult<T>> {
  requireDb();
  return pool.query<T>(sql, params);
}

export async function ensureDb(): Promise<void> {
  try {
    await dbImpl.runQuery(pool, "SELECT 1");
    deps.db.ready = true;
    deps.db.error = null;
    console.log("DB connected");
  } catch (error) {
    deps.db.ready = false;
    deps.db.error = error;
    console.error("DB connection failed", error);
    throw error;
  }
}

export function isDbReady(): boolean {
  return deps.db.ready;
}

const dbExports = {
  pool,
  db,
  getDb,
  runQuery,
  query,
  safeQuery,
  fetchClient,
  dbQuery,
  assertPoolHealthy,
  checkDb,
  warmUpDatabase,
  fetchInstrumentedClient,
  setDbTestPoolMetricsOverride,
  setDbTestFailureInjection,
  clearDbTestFailureInjection,
};

export default dbExports;
