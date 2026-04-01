"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.queryDb = queryDb;
exports.withDbTransaction = withDbTransaction;
exports.getPrisma = getPrisma;
const node_async_hooks_1 = require("node:async_hooks");
const pg_1 = require("pg");
const db_test_1 = require("./db.test");
let pool = null;
const transactionContext = new node_async_hooks_1.AsyncLocalStorage();
function getDb() {
    if (process.env.NODE_ENV === "test") {
        return (0, db_test_1.getTestDb)();
    }
    if (!pool) {
        if (!process.env.DATABASE_URL) {
            console.error("Missing DATABASE_URL");
            process.exit(1);
        }
        pool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
        });
    }
    return pool;
}
function validateQueryInputs(sql, params) {
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
async function executeQuery(queryable, sql, params) {
    validateQueryInputs(sql, params);
    return queryable.query(sql, params);
}
async function runQuery(queryable, sql, params) {
    if (transactionContext.getStore()) {
        return executeQuery(queryable, sql, params);
    }
    return withDbTransaction(async () => {
        return transactionContext.run(true, async () => executeQuery(queryable, sql, params));
    });
}
async function queryDb(query, params) {
    return runQuery(getDb(), query, params);
}
async function withDbTransaction(fn) {
    if (process.env.NODE_ENV === "test") {
        const db = getDb();
        await executeQuery(db, "BEGIN");
        try {
            const result = await transactionContext.run(true, async () => fn(queryDb));
            return result;
        }
        finally {
            await executeQuery(db, "ROLLBACK");
        }
    }
    const db = getDb();
    const client = await db.connect();
    const transactionalQuery = (query, params) => executeQuery(client, query, params);
    await transactionalQuery("BEGIN");
    try {
        return await transactionContext.run(true, async () => fn(transactionalQuery));
    }
    finally {
        await transactionalQuery("ROLLBACK");
        client.release();
    }
}
async function getPrisma() {
    throw new Error("Prisma not implemented");
}
