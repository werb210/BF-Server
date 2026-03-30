"use strict";
/**
 * Database module resolver.
 * Uses the production Postgres pool implementation in all environments.
 */
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
exports.clearDbTestFailureInjection = exports.setDbTestFailureInjection = exports.setDbTestPoolMetricsOverride = exports.fetchInstrumentedClient = exports.warmUpDatabase = exports.checkDb = exports.assertPoolHealthy = exports.dbQuery = exports.fetchClient = exports.query = exports.db = exports.pool = void 0;
const dbProd = __importStar(require("./db.prod"));
const dbImpl = dbProd;
exports.pool = dbImpl.pool, exports.db = dbImpl.db, exports.query = dbImpl.query, exports.fetchClient = dbImpl.fetchClient, exports.dbQuery = dbImpl.dbQuery, exports.assertPoolHealthy = dbImpl.assertPoolHealthy, exports.checkDb = dbImpl.checkDb, exports.warmUpDatabase = dbImpl.warmUpDatabase, exports.fetchInstrumentedClient = dbImpl.fetchInstrumentedClient, exports.setDbTestPoolMetricsOverride = dbImpl.setDbTestPoolMetricsOverride, exports.setDbTestFailureInjection = dbImpl.setDbTestFailureInjection, exports.clearDbTestFailureInjection = dbImpl.clearDbTestFailureInjection;
