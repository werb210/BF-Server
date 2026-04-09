import * as dbProd from "./db.prod.js";
import type { QueryResult, QueryResultRow } from "pg";

import { runQuery as runQueryFromDeps } from "./db/index.js";
import { deps } from "./system/deps.js";

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

export function getDb() {
  return pool;
}

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  return runQueryFromDeps<T>(text, params);
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return runQuery<T>(text, params);
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  return runQuery<T>(text, params);
}

export async function safeQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: any[],
): Promise<QueryResult<T>> {
  return runQuery<T>(sql, params);
}

export async function ensureDb(): Promise<void> {
  try {
    await runQuery("SELECT 1");
    deps.db.ready = true;
    console.log("DB connected");
  } catch (error) {
    deps.db.ready = false;
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
