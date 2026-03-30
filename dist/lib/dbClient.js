"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = exports.dbClient = void 0;
exports.testDbConnection = testDbConnection;
exports.query = query;
const circuitBreaker_1 = require("./circuitBreaker");
const retry_1 = require("./retry");
const dbClient_1 = require("../platform/dbClient");
Object.defineProperty(exports, "dbClient", { enumerable: true, get: function () { return dbClient_1.dbClient; } });
async function testDbConnection() {
    if (!(0, circuitBreaker_1.canExecute)()) {
        return false;
    }
    try {
        const start = Date.now();
        await (0, retry_1.retry)(() => dbClient_1.dbClient.query('SELECT 1'));
        const duration = Date.now() - start;
        if (duration > 500) {
            console.warn(`Slow DB query: ${duration}ms`);
        }
        return true;
    }
    catch {
        (0, circuitBreaker_1.recordFailure)();
        return false;
    }
}
function query(text, params) {
    return dbClient_1.dbClient.query(text, params);
}
exports.pool = dbClient_1.dbClient;
