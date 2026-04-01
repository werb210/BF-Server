import { pool } from "../../db";
import { AppError } from "../../middleware/errors";
import { recordAuditEvent } from "../audit/audit.service";
import { fetchCircuitBreaker } from "../../utils/circuitBreaker";
import type { Role } from "../../auth/roles";
import { config } from "../../config";
import { assertRetryAllowed } from "./retryPolicy";

type RetryJobResult = {
  jobId: string;
  jobType: "ocr" | "banking" | "credit_summary";
  applicationId: string | null;
  documentId: string | null;
  status: string;
  retryCount: number;
  lastRetryAt: Date | null;
  maxRetries: number;
  nextRetryInMs: number;
};

const OCR_BREAKER = fetchCircuitBreaker("ocr_job_creation", {
  failureThreshold: 3,
  cooldownMs: 60_000,
});
const BANKING_BREAKER = fetchCircuitBreaker("banking_job_creation", {
  failureThreshold: 3,
  cooldownMs: 60_000,
});
const CREDIT_BREAKER = fetchCircuitBreaker("credit_summary_generation", {
  failureThreshold: 3,
  cooldownMs: 60_000,
});

function fetchBreaker(jobType: RetryJobResult["jobType"]) {
  switch (jobType) {
    case "ocr":
      return OCR_BREAKER;
    case "banking":
      return BANKING_BREAKER;
    case "credit_summary":
      return CREDIT_BREAKER;
  }
}

export async function retryProcessingJob(params: {
  jobId: string;
  actorUserId: string;
  actorRole: Role;
  reason?: string | null;
  force?: boolean;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<RetryJobResult> {
  if (!config.flags.retryPolicyEnabled && !params.force) {
    throw new AppError("retry_disabled", "Retry policy is disabled.", 403);
  }
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const ocrJob = await client.runQuery<{
      id: string;
      application_id: string | null;
      document_id: string | null;
      status: string;
      retry_count: number;
      last_retry_at: Date | null;
      max_retries: number;
    }>(
      `select id, application_id, document_id, status, retry_count, last_retry_at, max_retries
       from document_processing_jobs
       where id = $1
       limit 1
       for update`,
      [params.jobId]
    );

    if (ocrJob.rows[0]) {
      const row = ocrJob.rows[0];
      const retryCount = row.retry_count ?? 0;
      const maxRetries = row.max_retries ?? 3;
      const breaker = fetchBreaker("ocr");
      if (!params.force && !breaker.canRequest()) {
        throw new AppError("circuit_open", "OCR circuit breaker is open.", 503);
      }
      const nextRetryInMs = params.force
        ? 0
        : assertRetryAllowed({
            retryCount,
            maxRetries,
            lastRetryAt: row.last_retry_at,
            baseDelayMs: 30_000,
          });
      const updated = await client.runQuery<{
        id: string;
        application_id: string | null;
        document_id: string | null;
        status: string;
        retry_count: number;
        last_retry_at: Date | null;
        max_retries: number;
      }>(
        `update document_processing_jobs
         set status = 'pending',
             completed_at = null,
             error_message = null,
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now()
         where id = $1
         returning id, application_id, document_id, status, retry_count, last_retry_at, max_retries`,
        [params.jobId]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new AppError("processing_retry_failed", "Failed to update processing job.", 500);
      }
      await recordAuditEvent({
        action: "processing_job_retried",
        actorUserId: params.actorUserId,
        targetUserId: null,
        targetType: "processing_job",
        targetId: updatedRow?.id ?? params.jobId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
          jobType: "ocr",
          retryCount: updatedRow?.retry_count ?? retryCount + 1,
          reason: params.reason ?? null,
          forced: Boolean(params.force),
        },
        client,
      });
      await client.runQuery("commit");
      return {
        jobId: updatedRow.id,
        jobType: "ocr",
        applicationId: updatedRow.application_id,
        documentId: updatedRow.document_id,
        status: updatedRow.status,
        retryCount: updatedRow.retry_count,
        lastRetryAt: updatedRow.last_retry_at,
        maxRetries: updatedRow.max_retries,
        nextRetryInMs,
      };
    }

    const bankingJob = await client.runQuery<{
      id: string;
      application_id: string | null;
      status: string;
      retry_count: number;
      last_retry_at: Date | null;
      max_retries: number;
    }>(
      `select id, application_id, status, retry_count, last_retry_at, max_retries
       from banking_analysis_jobs
       where id = $1
       limit 1
       for update`,
      [params.jobId]
    );
    if (bankingJob.rows[0]) {
      const row = bankingJob.rows[0];
      const retryCount = row.retry_count ?? 0;
      const maxRetries = row.max_retries ?? 2;
      const breaker = fetchBreaker("banking");
      if (!params.force && !breaker.canRequest()) {
        throw new AppError("circuit_open", "Banking circuit breaker is open.", 503);
      }
      const nextRetryInMs = params.force
        ? 0
        : assertRetryAllowed({
            retryCount,
            maxRetries,
            lastRetryAt: row.last_retry_at,
            baseDelayMs: 30_000,
          });
      const updated = await client.runQuery<{
        id: string;
        application_id: string | null;
        status: string;
        retry_count: number;
        last_retry_at: Date | null;
        max_retries: number;
      }>(
        `update banking_analysis_jobs
         set status = 'pending',
             completed_at = null,
             error_message = null,
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now()
         where id = $1
         returning id, application_id, status, retry_count, last_retry_at, max_retries`,
        [params.jobId]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new AppError("processing_retry_failed", "Failed to update processing job.", 500);
      }
      await recordAuditEvent({
        action: "processing_job_retried",
        actorUserId: params.actorUserId,
        targetUserId: null,
        targetType: "processing_job",
        targetId: updatedRow?.id ?? params.jobId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
          jobType: "banking",
          retryCount: updatedRow?.retry_count ?? retryCount + 1,
          reason: params.reason ?? null,
          forced: Boolean(params.force),
        },
        client,
      });
      await client.runQuery("commit");
      return {
        jobId: updatedRow.id,
        jobType: "banking",
        applicationId: updatedRow.application_id,
        documentId: null,
        status: updatedRow.status,
        retryCount: updatedRow.retry_count,
        lastRetryAt: updatedRow.last_retry_at,
        maxRetries: updatedRow.max_retries,
        nextRetryInMs,
      };
    }

    const creditJob = await client.runQuery<{
      id: string;
      application_id: string | null;
      status: string;
      retry_count: number;
      last_retry_at: Date | null;
      max_retries: number;
    }>(
      `select id, application_id, status, retry_count, last_retry_at, max_retries
       from credit_summary_jobs
       where id = $1
       limit 1
       for update`,
      [params.jobId]
    );
    if (creditJob.rows[0]) {
      const row = creditJob.rows[0];
      const retryCount = row.retry_count ?? 0;
      const maxRetries = row.max_retries ?? 1;
      const breaker = fetchBreaker("credit_summary");
      if (!params.force && !breaker.canRequest()) {
        throw new AppError("circuit_open", "Credit summary circuit breaker is open.", 503);
      }
      const nextRetryInMs = params.force
        ? 0
        : assertRetryAllowed({
            retryCount,
            maxRetries,
            lastRetryAt: row.last_retry_at,
            baseDelayMs: 30_000,
          });
      const updated = await client.runQuery<{
        id: string;
        application_id: string | null;
        status: string;
        retry_count: number;
        last_retry_at: Date | null;
        max_retries: number;
      }>(
        `update credit_summary_jobs
         set status = 'pending',
             completed_at = null,
             error_message = null,
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now()
         where id = $1
         returning id, application_id, status, retry_count, last_retry_at, max_retries`,
        [params.jobId]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new AppError("processing_retry_failed", "Failed to update processing job.", 500);
      }
      await recordAuditEvent({
        action: "processing_job_retried",
        actorUserId: params.actorUserId,
        targetUserId: null,
        targetType: "processing_job",
        targetId: updatedRow?.id ?? params.jobId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
          jobType: "credit_summary",
          retryCount: updatedRow?.retry_count ?? retryCount + 1,
          reason: params.reason ?? null,
          forced: Boolean(params.force),
        },
        client,
      });
      await client.runQuery("commit");
      return {
        jobId: updatedRow.id,
        jobType: "credit_summary",
        applicationId: updatedRow.application_id,
        documentId: null,
        status: updatedRow.status,
        retryCount: updatedRow.retry_count,
        lastRetryAt: updatedRow.last_retry_at,
        maxRetries: updatedRow.max_retries,
        nextRetryInMs,
      };
    }

    throw new AppError("not_found", "Processing job not found.", 404);
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function retryProcessingJobForApplication(params: {
  applicationId: string;
  actorUserId: string;
  actorRole: Role;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<RetryJobResult> {
  const job = await pool.runQuery<{
    id: string;
    job_type: RetryJobResult["jobType"];
  }>(
    `select id, job_type
     from (
       select id, 'ocr'::text as job_type, updated_at
       from document_processing_jobs
       where application_id = $1 and status = 'failed'
       union all
       select id, 'banking'::text as job_type, updated_at
       from banking_analysis_jobs
       where application_id = $1 and status = 'failed'
       union all
       select id, 'credit_summary'::text as job_type, updated_at
       from credit_summary_jobs
       where application_id = $1 and status = 'failed'
     ) failures
     order by updated_at desc
     limit 1`,
    [params.applicationId]
  );
  const row = job.rows[0];
  if (!row) {
    throw new AppError("not_found", "No failed processing job found.", 404);
  }
  return retryProcessingJob({
    jobId: row.id,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    reason: params.reason ?? null,
    force: true,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
  });
}
