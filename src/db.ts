import * as dbProd from "./db.prod";
import type { QueryResult, QueryResultRow } from "pg";

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

function assertDbInitialized(): void {
  if (!pool) {
    throw new Error("DB_NOT_INITIALIZED");
  }
}

type Queryable = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]) => Promise<QueryResult<T>>;
};

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  queryable: Queryable,
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  assertDbInitialized();
  try {
    return await dbImpl.runQuery<T>(queryable, text, params);
  } catch {
    throw new Error("DB_QUERY_FAILED");
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  assertDbInitialized();
  try {
    return await (dbImpl.query as unknown as (t: string, p?: any[]) => Promise<QueryResult<T>>)(text, params);
  } catch {
    throw new Error("DB_QUERY_FAILED");
  }
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]): Promise<QueryResult<T>> {
  assertDbInitialized();
  try {
    return await dbImpl.dbQuery<T>(text, params);
  } catch {
    throw new Error("DB_QUERY_FAILED");
  }
}

let dbReady = false;

export async function ensureDb(): Promise<void> {
  try {
    await pool.runQuery("SELECT 1");
    dbReady = true;
    console.log("DB connected");
  } catch (error) {
    dbReady = false;
    console.error("DB connection failed", error);
    throw error;
  }
}

export function isDbReady(): boolean {
  return dbReady;
}

const dbExports = {
  pool,
  db,
  runQuery,
  query,
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
