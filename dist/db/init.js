"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDb = initDb;
const pg_1 = require("pg");
const deps_1 = require("../system/deps");
async function initDb() {
    if (process.env.NODE_ENV === "test") {
        deps_1.deps.db.ready = true;
        deps_1.deps.db.client = {
            query: async () => ({ rows: [], rowCount: 1 }),
        };
        return;
    }
    const pool = new pg_1.Pool({
        connectionString: process.env.DATABASE_URL,
    });
    let connected = false;
    for (let i = 0; i < 3; i++) {
        try {
            await pool.query("SELECT 1");
            connected = true;
            break;
        }
        catch {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    deps_1.deps.db.ready = connected;
    deps_1.deps.db.client = connected ? pool : null;
}
