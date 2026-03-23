import { randomUUID } from "crypto";
import {
  upsertApplicationVolumeWindow,
  upsertDailyMetricsWindow,
  upsertDocumentMetricsWindow,
  upsertLenderFunnelWindow,
  upsertLenderPerformanceWindow,
  upsertPipelineDailySnapshot,
  upsertPipelineSnapshotAt,
  upsertStaffActivityWindow,
} from "./reporting.repo";
import { pool } from "../../db";
import {
  getReportingDailyIntervalMs,
  getReportingHourlyIntervalMs,
  getReportingJobsEnabled,
} from "../../server/config/config";
import { runWithRequestContext } from "../../middleware/requestContext";
import { logError, logInfo } from "../../observability/logger";
import { type PoolClient } from "pg";

function startOfDay(date: Date): Date {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

function addDays(date: Date, days: number): Date {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function startOfHour(date: Date): Date {
  const value = new Date(date);
  value.setUTCMinutes(0, 0, 0);
  return value;
}

async function runWithTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function runJobWithLogging(name: string, fn: () => Promise<number>): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  await runWithRequestContext(async () => {
    logInfo("reporting_job_started", { requestId, name });
    try {
      const rowCount = await fn();
      const durationMs = Date.now() - startedAt;
      logInfo("reporting_job_completed", { requestId, name, durationMs, rowCount });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      logError("reporting_job_failed", {
        requestId,
        name,
        durationMs,
        error: error instanceof Error ? error.message : "unknown_error",
      });
      throw error;
    }
  });
}

export async function runDailyMetricsJob(date = new Date()): Promise<number> {
  const start = startOfDay(date);
  const end = addDays(start, 1);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertDailyMetricsWindow({ start, end, createdAt, client })
  );
}

export async function runApplicationVolumeJob(date = new Date()): Promise<number> {
  const start = startOfDay(date);
  const end = addDays(start, 1);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertApplicationVolumeWindow({ start, end, createdAt, client })
  );
}

export async function runDocumentMetricsJob(date = new Date()): Promise<number> {
  const start = startOfDay(date);
  const end = addDays(start, 1);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertDocumentMetricsWindow({ start, end, createdAt, client })
  );
}

export async function runStaffActivityJob(date = new Date()): Promise<number> {
  const start = startOfDay(date);
  const end = addDays(start, 1);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertStaffActivityWindow({ start, end, createdAt, client })
  );
}

export async function runLenderFunnelJob(date = new Date()): Promise<number> {
  const start = startOfDay(date);
  const end = addDays(start, 1);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertLenderFunnelWindow({ start, end, createdAt, client })
  );
}

export async function runPipelineSnapshotJob(now = new Date()): Promise<number> {
  const snapshotAt = startOfHour(now);
  return runWithTransaction((client) =>
    upsertPipelineSnapshotAt({ snapshotAt, client })
  );
}

export async function runDailyPipelineSnapshotJob(date = new Date()): Promise<number> {
  const snapshotDate = startOfDay(date);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertPipelineDailySnapshot({ snapshotDate, createdAt, client })
  );
}

export async function runLenderPerformanceJob(date = new Date()): Promise<number> {
  const periodStart = startOfDay(addDays(date, -1));
  const periodEnd = startOfDay(date);
  const createdAt = new Date(date);
  return runWithTransaction((client) =>
    upsertLenderPerformanceWindow({ periodStart, periodEnd, createdAt, client })
  );
}

export function startReportingJobs(): { stop: () => void } {
  if (!getReportingJobsEnabled()) {
    return { stop: () => undefined };
  }

  const dailyInterval = getReportingDailyIntervalMs();
  const hourlyInterval = getReportingHourlyIntervalMs();

  const safeRun = (fn: () => Promise<void>) => {
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
