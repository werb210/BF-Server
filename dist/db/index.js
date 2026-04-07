"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runQuery = runQuery;
const deps_1 = require("../system/deps");
async function runQuery(text, params) {
    if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("runQuery requires a non-empty SQL query string");
    }
    if (Array.isArray(params) && params.some((value) => value === undefined)) {
        throw new Error("runQuery params must not include undefined");
    }
    if (!deps_1.deps.db.ready) {
        if (process.env.DATABASE_URL) {
            throw Object.assign(new Error("DB_NOT_READY"), { status: 503 });
        }
        throw Object.assign(new Error("DB_POOL_NOT_INITIALIZED"), { status: 503 });
    }
    if (!deps_1.deps.db.client) {
        throw Object.assign(new Error("DB_POOL_NOT_INITIALIZED"), { status: 503 });
    }
    return deps_1.deps.db.client.query(text, params);
}
