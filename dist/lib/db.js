import { Pool } from "pg";
let pool = null;
function validateQueryInputs(sql, params) {
    if (typeof sql !== "string" || !sql.trim()) {
        throw new Error("runQuery requires a non-empty SQL query string");
    }
    if (sql.includes("undefined")) {
        throw new Error("runQuery SQL must not contain undefined");
    }
    if (!Array.isArray(params)) {
        throw new Error("runQuery params must be an array when provided");
    }
    if (params.some((param) => typeof param === "undefined")) {
        throw new Error("runQuery params must not include undefined values");
    }
}
function initPool() {
    if (pool)
        return;
    if (!process.env.DATABASE_URL) {
        throw new Error("DB_POOL_NOT_INITIALIZED");
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
}
export async function runQuery(sql, params = []) {
    validateQueryInputs(sql, params);
    initPool();
    if (!pool) {
        throw new Error("DB_NOT_INITIALIZED");
    }
    const client = await pool.connect();
    let released = false;
    try {
        const result = await client.query(sql, params);
        return result;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`DB_QUERY_FAILED:${message}`);
    }
    finally {
        if (!released) {
            released = true;
            client.release();
        }
    }
}
export async function getPrisma() {
    throw new Error("Prisma not implemented");
}
