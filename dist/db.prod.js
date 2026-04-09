import { config } from "./config/index.js";
import pg from "pg";
import { logError, logInfo, logWarn } from "./observability/logger.js";
import { markNotReady } from "./startupState.js";
const { Pool } = pg;
const SLOW_QUERY_THRESHOLD_MS = 500;
export async function runQuery(queryable, text, params) {
    return queryable.query(text, params);
}
function buildPoolConfig() {
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
    };
}
export const pool = new Pool(buildPoolConfig());
export const db = pool;
export async function query(text, params) {
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
export async function dbQuery(text, params) {
    try {
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
    catch (err) {
        logError("db_query_error", { message: err.message, code: err.code });
        throw err;
    }
}
export function assertPoolHealthy() {
    const waitingCount = pool.waitingCount ?? 0;
    const totalCount = pool.totalCount ?? 0;
    const max = pool.options?.max ?? 0;
    if (max > 0 && waitingCount > 0 && totalCount >= max) {
        throw new Error("db_pool_exhausted");
    }
}
export async function checkDb() {
    await runQuery(pool, "select 1");
}
export async function warmUpDatabase() {
    await runQuery(pool, "select 1");
    assertPoolHealthy();
}
export async function fetchInstrumentedClient() {
    return pool.connect();
}
export function setDbTestPoolMetricsOverride() { }
export function setDbTestFailureInjection() { }
export function clearDbTestFailureInjection() { }
pool.on("connect", (client) => {
    void client
        .query("SET statement_timeout = 10000")
        .catch((err) => logWarn("db_statement_timeout_set_failed", { message: err.message }));
    logInfo("db_client_connected");
});
pool.on("error", (err) => {
    markNotReady("db_unavailable");
    logWarn("db_connection_error", { message: err.message });
});
