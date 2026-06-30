import { config } from "./config/index.js";
import pg, {
  type Pool as PgPool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { logError, logInfo, logWarn } from "./observability/logger.js";
import { markNotReady, markReady, isReady } from "./startupState.js";

const { Pool } = pg;

const SLOW_QUERY_THRESHOLD_MS = 500;
type Queryable = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, params?: any[]) => Promise<QueryResult<T>>;
};

export async function runQuery<T extends QueryResultRow = QueryResultRow>(
  queryable: Queryable,
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  return queryable.query<T>(text, params);
}

function buildPoolConfig(): PoolConfig {
  const connectionString = config.db.url.trim();
  if (!connectionString) {
    markNotReady("db_unavailable");
    logWarn("db_connection_string_missing");
    return {
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    };
  }

  const isAzure = connectionString.includes("postgres.database.azure.com");

  return {
    connectionString,
    ssl: isAzure ? { rejectUnauthorized: true } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // BF_SERVER_BLOCK_v791_KEEPALIVE — Azure silently drops idle TCP connections;
    // without keepalive a culled pooled connection throws read/connect ETIMEDOUT
    // on next use (the ocr.worker / readReceiptWorker errors). Keepalive probes
    // hold idle connections open so they survive Azure's idle cull.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

export const pool: PgPool = new Pool(buildPoolConfig());
export const db = pool;

export async function query(text: string, params?: any[]): Promise<QueryResult> {
  const start = Date.now();
  const result = await runQuery(pool, text, params);
  const durationMs = Date.now() - start;

  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    logWarn("db_slow_query", {
      durationMs,
      queryPreview: text.slice(0, 120),
    });
  }

  return result;
}

export function fetchClient() {
  return pool;
}

export async function dbQuery<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  try {
    const start = Date.now();
    const result = await runQuery<T>(pool, text, params);
    const durationMs = Date.now() - start;

    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logWarn("db_slow_query", {
        durationMs,
        queryPreview: text.slice(0, 120),
      });
    }

    return result;
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
  await runQuery(pool, "select 1");
}

export async function warmUpDatabase(): Promise<void> {
  await runQuery(pool, "select 1");
  assertPoolHealthy();
}

export async function fetchInstrumentedClient(): Promise<PoolClient> {
  return pool.connect();
}

export function setDbTestPoolMetricsOverride(): void {}
export function setDbTestFailureInjection(): void {}
export function clearDbTestFailureInjection(): void {}

pool.on("connect", (client) => {
  void client
    .query("SET statement_timeout = 10000")
    .catch((err: any) => logWarn("db_statement_timeout_set_failed", { message: err.message }));
  // BF_SERVER_BLOCK_v_LOG_NOISE_AND_NOTIF_DUPE_v1 — db_client_connected was logged on
  // EVERY pool connection, flooding the log and burying real errors. Removed.
});

pool.on("error", (err: any) => {
  markNotReady("db_unavailable");
  logWarn("db_connection_error", { message: err.message });
});

// v701: self-heal DB readiness. dbGuard returns 503 for all requests when
// !isReady(). A transient DB blip (Azure failover/maintenance) calls
// markNotReady() via pool.on("error"), but markReady() was previously only
// called once at startup — so the process stayed wedged in 503 until a manual
// restart even after Postgres recovered. This probe reconciles readiness with
// actual DB reachability every 10s, so the server recovers on its own.
let dbRecoveryTimer: ReturnType<typeof setInterval> | null = null;
function startDbReadinessProbe(): void {
  if (dbRecoveryTimer) return;
  dbRecoveryTimer = setInterval(() => {
    void pool
      .query("SELECT 1")
      .then(() => {
        if (!isReady()) {
          markReady();
          logInfo("db_recovered_marked_ready");
        }
      })
      .catch((err: any) => {
        markNotReady("db_unavailable");
        logWarn("db_readiness_probe_failed", { message: err?.message });
      });
  }, 10000);
  if (typeof (dbRecoveryTimer as any)?.unref === "function") (dbRecoveryTimer as any).unref();
}
startDbReadinessProbe();
