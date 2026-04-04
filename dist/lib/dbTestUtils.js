"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeSchema = initializeSchema;
exports.resetTestDb = resetTestDb;
exports.getTestDb = getTestDb;
exports.withTestTransaction = withTestTransaction;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { newDb } = require("pg-mem");
let dbInstance = null;
function initializeSchema(db) {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("Test database schema can only be initialized when NODE_ENV is 'test'");
    }
    db.public.none(`
    CREATE TABLE IF NOT EXISTS health_check (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
}
async function resetTestDb() {
    const db = newDb();
    initializeSchema(db);
    const adapter = db.adapters.createPg();
    dbInstance = new adapter.Pool();
}
function getTestDb() {
    if (process.env.NODE_ENV !== "test") {
        throw new Error("Test database is only available when NODE_ENV is 'test'");
    }
    if (!dbInstance) {
        void resetTestDb();
    }
    return dbInstance;
}
async function withTestTransaction(fn) {
    const db = getTestDb();
    await db.query("BEGIN");
    try {
        return await fn();
    }
    finally {
        await db.query("ROLLBACK");
    }
}
