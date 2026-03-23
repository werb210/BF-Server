import { config } from "@/config";
import pg, {
  type Pool as PgPool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { logError, logInfo, logWarn } from "./observability/logger";
import { markNotReady } from "./startupState";

const { Pool } = pg;

function buildPoolConfig(): PoolConfig {
  const connectionString = config.db.url.trim();
  if (!connectionString) {
    markNotReady("db_unavailable");
    throw new Error("DATABASE_URL is missing");
  }

  const isAzure = connectionString.includes("postgres.database.azure.com");
  const isLocal =
    connectionString.includes("localhost") ||
    connectionString.includes("127.0.0.1");

  return {
    connectionString,
    ssl: isAzure ? { rejectUnauthorized: true } : isLocal ? false : false,
    max: 20,
  };
}

export const pool: PgPool = new Pool(buildPoolConfig());
export const db = pool;

export function query(text: string, params?: any[]): Promise<QueryResult> {
  return pool.query(text, params);
}

export function fetchClient() {
  return pool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  try {
    return await pool.query<T>(text, params);
  } catch (err: any) {
    logError("db_query_error", { message: err.message, code: err.code });
    throw err;
  }
}

export function assertPoolHealthy(): void {
  const waitingCount = pool.waitingCount ?? 0;
  const totalCount = pool.totalCount ?? 0;
  const max = pool.options?.max ?? 0;
  if (max > 0 && waitingCount > 0 && totalCount >= max) {
    throw new Error("db_pool_exhausted");
  }
}

export async function checkDb(): Promise<void> {
  await pool.query("select 1");
}

export async function warmUpDatabase(): Promise<void> {
  await pool.query("select 1");
  assertPoolHealthy();
}

export async function fetchInstrumentedClient(): Promise<PoolClient> {
  return pool.connect();
}

export function setDbTestPoolMetricsOverride(): void {}
export function setDbTestFailureInjection(): void {}
export function clearDbTestFailureInjection(): void {}

pool.on("connect", () => logInfo("db_client_connected"));

pool.on("error", (err: any) => {
  markNotReady("db_unavailable");
  logWarn("db_connection_error", { message: err.message });
});
