"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbHealth = dbHealth;
exports.assertDatabaseHealthy = assertDatabaseHealthy;
const dbClient_1 = require("../lib/dbClient");
async function dbHealth() {
    const ok = await (0, dbClient_1.testDbConnection)();
    return { db: ok ? 'ok' : 'fail' };
}
async function assertDatabaseHealthy() {
    const ok = await (0, dbClient_1.testDbConnection)();
    if (!ok) {
        throw new Error('database_not_healthy');
    }
}
