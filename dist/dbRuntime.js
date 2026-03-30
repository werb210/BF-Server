"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTestEnvironment = void 0;
exports.isTestEnv = isTestEnv;
exports.isDbConnectionFailure = isDbConnectionFailure;
exports.fetchDbFailureCategory = fetchDbFailureCategory;
exports.cancelDbWork = cancelDbWork;
const db_1 = require("./db");
const logger_1 = require("./platform/logger");
const config_1 = require("./config");
function isTestEnv() {
    return config_1.config.env === "test";
}
const connectionFailureCodes = new Set([
    "57P01",
    "57P02",
    "57P03",
    "08006",
    "08003",
    "08001",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
]);
function isDbConnectionFailure(err) {
    if (!(err instanceof Error)) {
        return false;
    }
    const code = err.code;
    if (code && connectionFailureCodes.has(code)) {
        return true;
    }
    const message = err.message.toLowerCase();
    return (message.includes("terminating connection") ||
        message.includes("connection terminated") ||
        message.includes("connection refused") ||
        message.includes("connection reset") ||
        message.includes("could not connect") ||
        message.includes("timeout"));
}
function fetchDbFailureCategory(err) {
    if (!(err instanceof Error)) {
        return null;
    }
    const code = err.code;
    if (code === "53300") {
        return "pool_exhausted";
    }
    if (isDbConnectionFailure(err)) {
        return "connection_failure";
    }
    const message = err.message.toLowerCase();
    if (message.includes("too many clients")) {
        return "pool_exhausted";
    }
    return null;
}
async function cancelDbWork(processIds) {
    if (!processIds.length) {
        return;
    }
    try {
        await db_1.pool.query("select pg_cancel_backend(pid) from unnest($1::int[]) as pid", [
            processIds,
        ]);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "unknown_error";
        logger_1.logger.error("db_cancel_error", { message });
    }
}
exports.isTestEnvironment = isTestEnv;
