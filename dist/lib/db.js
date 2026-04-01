"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runQuery = runQuery;
exports.getPrisma = getPrisma;
const pg_1 = require("pg");
const db_test_1 = require("./db.test");
let pool = null;
function validateQueryInputs(sql, params) {
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
function getQueryable() {
    if (process.env.NODE_ENV === "test") {
        return (0, db_test_1.getTestDb)();
    }
    if (!process.env.DATABASE_URL) {
        console.error("Missing DATABASE_URL");
        process.exit(1);
    }
    if (!pool) {
        pool = new pg_1.Pool({ connectionString: process.env.DATABASE_URL });
    }
    return pool;
}
async function runQuery(sql, params) {
    validateQueryInputs(sql, params);
    return getQueryable().query(sql, params);
}
async function getPrisma() {
    throw new Error("Prisma not implemented");
}
