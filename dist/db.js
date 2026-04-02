"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearDbTestFailureInjection = exports.setDbTestFailureInjection = exports.setDbTestPoolMetricsOverride = exports.fetchInstrumentedClient = exports.warmUpDatabase = exports.checkDb = exports.assertPoolHealthy = exports.fetchClient = exports.db = exports.pool = void 0;
exports.getDb = getDb;
exports.runQuery = runQuery;
exports.query = query;
exports.dbQuery = dbQuery;
exports.safeQuery = safeQuery;
exports.ensureDb = ensureDb;
exports.isDbReady = isDbReady;
const dbProd = __importStar(require("./db.prod"));
const deps_1 = require("./system/deps");
const requireDb_1 = require("./system/requireDb");
const dbImpl = dbProd;
exports.pool = dbImpl.pool, exports.db = dbImpl.db, exports.fetchClient = dbImpl.fetchClient, exports.assertPoolHealthy = dbImpl.assertPoolHealthy, exports.checkDb = dbImpl.checkDb, exports.warmUpDatabase = dbImpl.warmUpDatabase, exports.fetchInstrumentedClient = dbImpl.fetchInstrumentedClient, exports.setDbTestPoolMetricsOverride = dbImpl.setDbTestPoolMetricsOverride, exports.setDbTestFailureInjection = dbImpl.setDbTestFailureInjection, exports.clearDbTestFailureInjection = dbImpl.clearDbTestFailureInjection;
function getDb() {
    (0, requireDb_1.requireDb)();
    return exports.pool;
}
async function runQuery(text, params) {
    (0, requireDb_1.requireDb)();
    if (typeof exports.pool.runQuery !== "undefined") {
        throw new Error("DO NOT ATTACH METHODS TO pool");
    }
    try {
        return await exports.pool.query(text, params);
    }
    catch {
        throw new Error("DB_QUERY_FAILED");
    }
}
async function query(text, params) {
    return runQuery(text, params);
}
async function dbQuery(text, params) {
    (0, requireDb_1.requireDb)();
    try {
        return await dbImpl.dbQuery(text, params);
    }
    catch {
        throw new Error("DB_QUERY_FAILED");
    }
}
async function safeQuery(sql, params) {
    return runQuery(sql, params);
}
async function ensureDb() {
    try {
        await runQuery("SELECT 1");
        deps_1.deps.db.ready = true;
        deps_1.deps.db.error = null;
        console.log("DB connected");
    }
    catch (error) {
        deps_1.deps.db.ready = false;
        deps_1.deps.db.error = error;
        console.error("DB connection failed", error);
        throw error;
    }
}
function isDbReady() {
    return deps_1.deps.db.ready;
}
const dbExports = {
    pool: exports.pool,
    db: exports.db,
    getDb,
    runQuery,
    query,
    safeQuery,
    fetchClient: exports.fetchClient,
    dbQuery,
    assertPoolHealthy: exports.assertPoolHealthy,
    checkDb: exports.checkDb,
    warmUpDatabase: exports.warmUpDatabase,
    fetchInstrumentedClient: exports.fetchInstrumentedClient,
    setDbTestPoolMetricsOverride: exports.setDbTestPoolMetricsOverride,
    setDbTestFailureInjection: exports.setDbTestFailureInjection,
    clearDbTestFailureInjection: exports.clearDbTestFailureInjection,
};
exports.default = dbExports;
