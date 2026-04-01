"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.pool = void 0;
exports.runQuery = runQuery;
exports.query = query;
exports.fetchClient = fetchClient;
exports.dbQuery = dbQuery;
exports.assertPoolHealthy = assertPoolHealthy;
exports.checkDb = checkDb;
exports.warmUpDatabase = warmUpDatabase;
exports.fetchInstrumentedClient = fetchInstrumentedClient;
exports.setDbTestPoolMetricsOverride = setDbTestPoolMetricsOverride;
exports.setDbTestFailureInjection = setDbTestFailureInjection;
exports.clearDbTestFailureInjection = clearDbTestFailureInjection;
const config_1 = require("./config");
const pg_1 = __importDefault(require("pg"));
const logger_1 = require("./observability/logger");
const startupState_1 = require("./startupState");
const { Pool } = pg_1.default;
const SLOW_QUERY_THRESHOLD_MS = 500;
async function runQuery(queryable, text, params) {
    return queryable.query(text, params);
}
function buildPoolConfig() {
    const connectionString = config_1.config.db.url.trim();
    if (!connectionString) {
        (0, startupState_1.markNotReady)("db_unavailable");
        throw new Error("DATABASE_URL is missing");
    }
    const isAzure = connectionString.includes("postgres.database.azure.com");
    return {
        connectionString,
        ssl: isAzure ? { rejectUnauthorized: true } : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    };
}
exports.pool = new Pool(buildPoolConfig());
exports.db = exports.pool;
const attachRunQuery = (queryable) => {
    queryable.runQuery = (text, params) => runQuery(queryable, text, params);
};
attachRunQuery(exports.pool);
const originalPoolConnect = exports.pool.connect.bind(exports.pool);
exports.pool.connect = async (...args) => {
    const client = await originalPoolConnect(...args);
    attachRunQuery(client);
    return client;
};
async function query(text, params) {
    const start = Date.now();
    const result = await exports.pool.runQuery(text, params);
    const durationMs = Date.now() - start;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
        (0, logger_1.logWarn)("db_slow_query", {
            durationMs,
            queryPreview: text.slice(0, 120),
        });
    }
    return result;
}
function fetchClient() {
    return exports.pool;
}
async function dbQuery(text, params) {
    try {
        const start = Date.now();
        const result = await exports.pool.runQuery(text, params);
        const durationMs = Date.now() - start;
        if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
            (0, logger_1.logWarn)("db_slow_query", {
                durationMs,
                queryPreview: text.slice(0, 120),
            });
        }
        return result;
    }
    catch (err) {
        (0, logger_1.logError)("db_query_error", { message: err.message, code: err.code });
        throw err;
    }
}
function assertPoolHealthy() {
    const waitingCount = exports.pool.waitingCount ?? 0;
    const totalCount = exports.pool.totalCount ?? 0;
    const max = exports.pool.options?.max ?? 0;
    if (max > 0 && waitingCount > 0 && totalCount >= max) {
        throw new Error("db_pool_exhausted");
    }
}
async function checkDb() {
    await exports.pool.runQuery("select 1");
}
async function warmUpDatabase() {
    await exports.pool.runQuery("select 1");
    assertPoolHealthy();
}
async function fetchInstrumentedClient() {
    const client = await exports.pool.connect();
    attachRunQuery(client);
    return client;
}
function setDbTestPoolMetricsOverride() { }
function setDbTestFailureInjection() { }
function clearDbTestFailureInjection() { }
exports.pool.on("connect", () => (0, logger_1.logInfo)("db_client_connected"));
exports.pool.on("error", (err) => {
    (0, startupState_1.markNotReady)("db_unavailable");
    (0, logger_1.logWarn)("db_connection_error", { message: err.message });
});
