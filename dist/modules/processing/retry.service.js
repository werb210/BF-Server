"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.retryProcessingJob = retryProcessingJob;
exports.retryProcessingJobForApplication = retryProcessingJobForApplication;
const db_1 = require("../../db");
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const circuitBreaker_1 = require("../../utils/circuitBreaker");
const config_1 = require("../../config");
const retryPolicy_1 = require("./retryPolicy");
const OCR_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("ocr_job_creation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
const BANKING_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("banking_job_creation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
const CREDIT_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("credit_summary_generation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
function fetchBreaker(jobType) {
    switch (jobType) {
        case "ocr":
            return OCR_BREAKER;
        case "banking":
            return BANKING_BREAKER;
        case "credit_summary":
            return CREDIT_BREAKER;
    }
}
async function retryProcessingJob(params) {
    if (!config_1.config.flags.retryPolicyEnabled && !params.force) {
        throw new errors_1.AppError("retry_disabled", "Retry policy is disabled.", 403);
    }
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        const ocrJob = await client.query(`select id, application_id, document_id, status, retry_count, last_retry_at, max_retries
       from document_processing_jobs
       where id = $1
       limit 1
       for update`, [params.jobId]);
        if (ocrJob.rows[0]) {
            const row = ocrJob.rows[0];
            const retryCount = row.retry_count ?? 0;
            const maxRetries = row.max_retries ?? 3;
            const breaker = fetchBreaker("ocr");
            if (!params.force && !breaker.canRequest()) {
                throw new errors_1.AppError("circuit_open", "OCR circuit breaker is open.", 503);
            }
            const nextRetryInMs = params.force
                ? 0
                : (0, retryPolicy_1.assertRetryAllowed)({
                    retryCount,
                    maxRetries,
                    lastRetryAt: row.last_retry_at,
                    baseDelayMs: 30000,
                });
            const updated = await client.query(`update document_processing_jobs
         set status = 'pending',
             completed_at = null,
             error_message = null,
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now()
         where id = $1
         returning id, application_id, document_id, status, retry_count, last_retry_at, max_retries`, [params.jobId]);
            const updatedRow = updated.rows[0];
            if (!updatedRow) {
                throw new errors_1.AppError("processing_retry_failed", "Failed to update processing job.", 500);
            }
            await (0, audit_service_1.recordAuditEvent)({
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
            await client.query("commit");
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
        const bankingJob = await client.query(`select id, application_id, status, retry_count, last_retry_at, max_retries
       from banking_analysis_jobs
       where id = $1
       limit 1
       for update`, [params.jobId]);
        if (bankingJob.rows[0]) {
            const row = bankingJob.rows[0];
            const retryCount = row.retry_count ?? 0;
            const maxRetries = row.max_retries ?? 2;
            const breaker = fetchBreaker("banking");
            if (!params.force && !breaker.canRequest()) {
                throw new errors_1.AppError("circuit_open", "Banking circuit breaker is open.", 503);
            }
            const nextRetryInMs = params.force
                ? 0
                : (0, retryPolicy_1.assertRetryAllowed)({
                    retryCount,
                    maxRetries,
                    lastRetryAt: row.last_retry_at,
                    baseDelayMs: 30000,
                });
            const updated = await client.query(`update banking_analysis_jobs
         set status = 'pending',
             completed_at = null,
             error_message = null,
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now()
         where id = $1
         returning id, application_id, status, retry_count, last_retry_at, max_retries`, [params.jobId]);
            const updatedRow = updated.rows[0];
            if (!updatedRow) {
                throw new errors_1.AppError("processing_retry_failed", "Failed to update processing job.", 500);
            }
            await (0, audit_service_1.recordAuditEvent)({
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
            await client.query("commit");
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
        const creditJob = await client.query(`select id, application_id, status, retry_count, last_retry_at, max_retries
       from credit_summary_jobs
       where id = $1
       limit 1
       for update`, [params.jobId]);
        if (creditJob.rows[0]) {
            const row = creditJob.rows[0];
            const retryCount = row.retry_count ?? 0;
            const maxRetries = row.max_retries ?? 1;
            const breaker = fetchBreaker("credit_summary");
            if (!params.force && !breaker.canRequest()) {
                throw new errors_1.AppError("circuit_open", "Credit summary circuit breaker is open.", 503);
            }
            const nextRetryInMs = params.force
                ? 0
                : (0, retryPolicy_1.assertRetryAllowed)({
                    retryCount,
                    maxRetries,
                    lastRetryAt: row.last_retry_at,
                    baseDelayMs: 30000,
                });
            const updated = await client.query(`update credit_summary_jobs
         set status = 'pending',
             completed_at = null,
             error_message = null,
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now()
         where id = $1
         returning id, application_id, status, retry_count, last_retry_at, max_retries`, [params.jobId]);
            const updatedRow = updated.rows[0];
            if (!updatedRow) {
                throw new errors_1.AppError("processing_retry_failed", "Failed to update processing job.", 500);
            }
            await (0, audit_service_1.recordAuditEvent)({
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
            await client.query("commit");
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
        throw new errors_1.AppError("not_found", "Processing job not found.", 404);
    }
    catch (err) {
        await client.query("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function retryProcessingJobForApplication(params) {
    const job = await db_1.pool.query(`select id, job_type
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
     limit 1`, [params.applicationId]);
    const row = job.rows[0];
    if (!row) {
        throw new errors_1.AppError("not_found", "No failed processing job found.", 404);
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
