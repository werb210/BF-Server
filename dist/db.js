import * as dbProd from "./db.prod.js";
import { runQuery as runQueryFromDeps } from "./db/index.js";
import { deps } from "./system/deps.js";
const dbImpl = dbProd;
export const { pool, db, fetchClient, assertPoolHealthy, checkDb, warmUpDatabase, fetchInstrumentedClient, setDbTestPoolMetricsOverride, setDbTestFailureInjection, clearDbTestFailureInjection, } = dbImpl;
export function getDb() {
    return pool;
}
export async function runQuery(text, params) {
    return runQueryFromDeps(text, params);
}
export async function query(text, params) {
    return runQuery(text, params);
}
export async function dbQuery(text, params) {
    return runQuery(text, params);
}
export async function safeQuery(sql, params) {
    return runQuery(sql, params);
}
export async function ensureDb() {
    try {
        await runQuery("SELECT 1");
        deps.db.ready = true;
        console.log("DB connected");
    }
    catch (error) {
        deps.db.ready = false;
        console.error("DB connection failed", error);
        throw error;
    }
}
export function isDbReady() {
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
