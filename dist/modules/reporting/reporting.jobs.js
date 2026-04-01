"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runDailyMetricsJob = runDailyMetricsJob;
exports.runApplicationVolumeJob = runApplicationVolumeJob;
exports.runDocumentMetricsJob = runDocumentMetricsJob;
exports.runStaffActivityJob = runStaffActivityJob;
exports.runLenderFunnelJob = runLenderFunnelJob;
exports.runPipelineSnapshotJob = runPipelineSnapshotJob;
exports.runDailyPipelineSnapshotJob = runDailyPipelineSnapshotJob;
exports.runLenderPerformanceJob = runLenderPerformanceJob;
exports.startReportingJobs = startReportingJobs;
const crypto_1 = require("crypto");
const reporting_repo_1 = require("./reporting.repo");
const db_1 = require("../../db");
const config_1 = require("../../config");
const requestContext_1 = require("../../middleware/requestContext");
const logger_1 = require("../../observability/logger");
function startOfDay(date) {
    const value = new Date(date);
    value.setUTCHours(0, 0, 0, 0);
    return value;
}
function addDays(date, days) {
    const value = new Date(date);
    value.setUTCDate(value.getUTCDate() + days);
    return value;
}
function startOfHour(date) {
    const value = new Date(date);
    value.setUTCMinutes(0, 0, 0);
    return value;
}
async function runWithTransaction(fn) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const result = await fn(client);
        await client.runQuery("commit");
        return result;
    }
    catch (error) {
        await client.runQuery("rollback");
        throw error;
    }
    finally {
        client.release();
    }
}
async function runJobWithLogging(name, fn) {
    const requestId = (0, crypto_1.randomUUID)();
    const startedAt = Date.now();
    await (0, requestContext_1.runWithRequestContext)(async () => {
        (0, logger_1.logInfo)("reporting_job_started", { requestId, name });
        try {
            const rowCount = await fn();
            const durationMs = Date.now() - startedAt;
            (0, logger_1.logInfo)("reporting_job_completed", { requestId, name, durationMs, rowCount });
        }
        catch (error) {
            const durationMs = Date.now() - startedAt;
            (0, logger_1.logError)("reporting_job_failed", {
                requestId,
                name,
                durationMs,
                error: error instanceof Error ? error.message : "unknown_error",
            });
            throw error;
        }
    });
}
async function runDailyMetricsJob(date = new Date()) {
    const start = startOfDay(date);
    const end = addDays(start, 1);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertDailyMetricsWindow)({ start, end, createdAt, client }));
}
async function runApplicationVolumeJob(date = new Date()) {
    const start = startOfDay(date);
    const end = addDays(start, 1);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertApplicationVolumeWindow)({ start, end, createdAt, client }));
}
async function runDocumentMetricsJob(date = new Date()) {
    const start = startOfDay(date);
    const end = addDays(start, 1);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertDocumentMetricsWindow)({ start, end, createdAt, client }));
}
async function runStaffActivityJob(date = new Date()) {
    const start = startOfDay(date);
    const end = addDays(start, 1);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertStaffActivityWindow)({ start, end, createdAt, client }));
}
async function runLenderFunnelJob(date = new Date()) {
    const start = startOfDay(date);
    const end = addDays(start, 1);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertLenderFunnelWindow)({ start, end, createdAt, client }));
}
async function runPipelineSnapshotJob(now = new Date()) {
    const snapshotAt = startOfHour(now);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertPipelineSnapshotAt)({ snapshotAt, client }));
}
async function runDailyPipelineSnapshotJob(date = new Date()) {
    const snapshotDate = startOfDay(date);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertPipelineDailySnapshot)({ snapshotDate, createdAt, client }));
}
async function runLenderPerformanceJob(date = new Date()) {
    const periodStart = startOfDay(addDays(date, -1));
    const periodEnd = startOfDay(date);
    const createdAt = new Date(date);
    return runWithTransaction((client) => (0, reporting_repo_1.upsertLenderPerformanceWindow)({ periodStart, periodEnd, createdAt, client }));
}
function startReportingJobs() {
    if (!config_1.config.flags.reportingJobsEnabled) {
        return { stop: () => undefined };
    }
    const dailyInterval = config_1.config.flags.reportingDailyIntervalMs;
    const hourlyInterval = config_1.config.flags.reportingHourlyIntervalMs;
    const safeRun = (fn) => {
        fn().catch(() => undefined);
    };
    const runDailyJobs = () => {
        safeRun(() => runJobWithLogging("daily_metrics", () => runDailyMetricsJob()));
        safeRun(() => runJobWithLogging("application_volume", () => runApplicationVolumeJob()));
        safeRun(() => runJobWithLogging("document_metrics", () => runDocumentMetricsJob()));
        safeRun(() => runJobWithLogging("staff_activity", () => runStaffActivityJob()));
        safeRun(() => runJobWithLogging("lender_funnel", () => runLenderFunnelJob()));
        safeRun(() => runJobWithLogging("lender_performance", () => runLenderPerformanceJob()));
        safeRun(() => runJobWithLogging("pipeline_snapshot_daily", () => runDailyPipelineSnapshotJob()));
    };
    const runHourlyJobs = () => {
        safeRun(() => runJobWithLogging("pipeline_snapshot", () => runPipelineSnapshotJob()));
    };
    const dailyTimer = setInterval(runDailyJobs, dailyInterval);
    const hourlyTimer = setInterval(runHourlyJobs, hourlyInterval);
    runDailyJobs();
    runHourlyJobs();
    return {
        stop: () => {
            clearInterval(dailyTimer);
            clearInterval(hourlyTimer);
        },
    };
}
