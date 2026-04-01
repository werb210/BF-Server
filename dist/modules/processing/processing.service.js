"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDocumentProcessingJob = createDocumentProcessingJob;
exports.markDocumentProcessingCompleted = markDocumentProcessingCompleted;
exports.markDocumentProcessingFailed = markDocumentProcessingFailed;
exports.createBankingAnalysisJob = createBankingAnalysisJob;
exports.markBankingAnalysisCompleted = markBankingAnalysisCompleted;
exports.markBankingAnalysisFailed = markBankingAnalysisFailed;
const db_1 = require("../../db");
const errors_1 = require("../../middleware/errors");
const requiredDocuments_1 = require("../../db/schema/requiredDocuments");
const processingStage_service_1 = require("../applications/processingStage.service");
const crypto_1 = require("crypto");
const circuitBreaker_1 = require("../../utils/circuitBreaker");
const config_1 = require("../../config");
const retryPolicy_1 = require("./retryPolicy");
const BANK_STATEMENT_CATEGORY = "bank_statements_6_months";
const OCR_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("ocr_job_creation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
const BANKING_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("banking_job_creation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
async function lockDocument(params) {
    const res = await params.client.runQuery("select application_id from documents where id = $1 for update", [params.documentId]);
    const record = res.rows[0];
    if (!record) {
        throw new errors_1.AppError("not_found", "Document not found.", 404);
    }
    if (record.application_id !== params.applicationId) {
        throw new errors_1.AppError("document_mismatch", "Document does not match application.", 400);
    }
}
async function lockApplication(params) {
    const res = await params.client.runQuery("select id from applications where id = $1 for update", [params.applicationId]);
    if (res.rows.length === 0) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
}
async function createDocumentProcessingJob(applicationId, documentId) {
    if (!OCR_BREAKER.canRequest()) {
        throw new errors_1.AppError("circuit_open", "OCR circuit breaker is open.", 503);
    }
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        await lockDocument({ applicationId, documentId, client });
        const existing = await client.runQuery(`select id, application_id, document_id, status, created_at, completed_at,
              retry_count, last_retry_at, max_retries, updated_at
       from document_processing_jobs
       where application_id = $1 and document_id = $2`, [applicationId, documentId]);
        const existingRecord = existing.rows[0];
        if (existingRecord) {
            if (config_1.config.flags.retryPolicyEnabled &&
                existingRecord.status === "failed") {
                const retryCount = existingRecord.retry_count ?? 0;
                const maxRetries = existingRecord.max_retries ?? 3;
                (0, retryPolicy_1.assertRetryAllowed)({
                    retryCount,
                    maxRetries,
                    lastRetryAt: existingRecord.last_retry_at ?? null,
                    baseDelayMs: 30000,
                });
                const updated = await client.runQuery(`update document_processing_jobs
           set status = 'pending',
               retry_count = retry_count + 1,
               last_retry_at = now(),
               updated_at = now(),
               completed_at = null,
               error_message = null
           where id = $1
           returning id, application_id, document_id, status, created_at, completed_at,
                     retry_count, last_retry_at, max_retries, updated_at`, [existingRecord.id]);
                await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
                await client.runQuery("commit");
                OCR_BREAKER.recordSuccess();
                return updated.rows[0] ?? existingRecord;
            }
            await client.runQuery("commit");
            return existingRecord;
        }
        const inserted = await client.runQuery(`insert into document_processing_jobs
       (id, application_id, document_id, status)
       values ($1, $2, $3, 'pending')
       returning id, application_id, document_id, status, created_at, completed_at`, [(0, crypto_1.randomUUID)(), applicationId, documentId]);
        await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
        await client.runQuery("commit");
        const insertedRecord = inserted.rows[0];
        if (!insertedRecord) {
            throw new errors_1.AppError("data_error", "OCR job not created.", 500);
        }
        OCR_BREAKER.recordSuccess();
        return insertedRecord;
    }
    catch (err) {
        if (!(err instanceof errors_1.AppError) ||
            !["retry_backoff", "retry_exhausted"].includes(err.code)) {
            OCR_BREAKER.recordFailure();
        }
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markDocumentProcessingCompleted(applicationId) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const existing = await client.runQuery(`select id, application_id, document_id, status, created_at, completed_at
       from document_processing_jobs
       where application_id = $1
       for update`, [applicationId]);
        if (existing.rows.length === 0) {
            throw new errors_1.AppError("not_found", "OCR jobs not found.", 404);
        }
        await client.runQuery(`update document_processing_jobs
       set status = 'completed', completed_at = now()
       where application_id = $1 and status = 'pending'`, [applicationId]);
        await client.runQuery(`update applications
       set ocr_completed_at = coalesce(ocr_completed_at, now()),
           updated_at = now()
       where id = $1`, [applicationId]);
        await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
        const updated = await client.runQuery(`select id, application_id, document_id, status, created_at, completed_at
       from document_processing_jobs
       where application_id = $1`, [applicationId]);
        await client.runQuery("commit");
        return updated.rows;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markDocumentProcessingFailed(applicationId) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const existing = await client.runQuery(`select id, application_id, document_id, status, created_at, completed_at
       from document_processing_jobs
       where application_id = $1
       for update`, [applicationId]);
        if (existing.rows.length === 0) {
            throw new errors_1.AppError("not_found", "OCR jobs not found.", 404);
        }
        await client.runQuery(`update document_processing_jobs
       set status = 'failed', completed_at = now()
       where application_id = $1 and status = 'pending'`, [applicationId]);
        const updated = await client.runQuery(`select id, application_id, document_id, status, created_at, completed_at
       from document_processing_jobs
       where application_id = $1`, [applicationId]);
        await client.runQuery("commit");
        return updated.rows;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function createBankingAnalysisJob(applicationId) {
    if (!BANKING_BREAKER.canRequest()) {
        throw new errors_1.AppError("circuit_open", "Banking circuit breaker is open.", 503);
    }
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        await lockApplication({ applicationId, client });
        const existing = await client.runQuery(`select id, application_id, status, created_at, completed_at,
              retry_count, last_retry_at, max_retries, updated_at
       from banking_analysis_jobs
       where application_id = $1`, [applicationId]);
        const existingRecord = existing.rows[0];
        if (existingRecord) {
            if (config_1.config.flags.retryPolicyEnabled &&
                existingRecord.status === "failed") {
                const retryCount = existingRecord.retry_count ?? 0;
                const maxRetries = existingRecord.max_retries ?? 2;
                (0, retryPolicy_1.assertRetryAllowed)({
                    retryCount,
                    maxRetries,
                    lastRetryAt: existingRecord.last_retry_at ?? null,
                    baseDelayMs: 30000,
                });
                const updated = await client.runQuery(`update banking_analysis_jobs
           set status = 'pending',
               retry_count = retry_count + 1,
               last_retry_at = now(),
               updated_at = now(),
               completed_at = null,
               error_message = null
           where id = $1
           returning id, application_id, status, created_at, completed_at,
                     retry_count, last_retry_at, max_retries, updated_at`, [existingRecord.id]);
                await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
                await client.runQuery("commit");
                BANKING_BREAKER.recordSuccess();
                return updated.rows[0] ?? existingRecord;
            }
            await client.runQuery("commit");
            BANKING_BREAKER.recordSuccess();
            return existingRecord;
        }
        const aliases = (0, requiredDocuments_1.fetchDocumentTypeAliases)(BANK_STATEMENT_CATEGORY);
        const countRes = await client.runQuery(`select count(*)::int as count
       from documents
       where application_id = $1
         and document_type = any($2)
         and status = 'uploaded'`, [applicationId, aliases]);
        const count = countRes.rows[0]?.count ?? 0;
        if (count < 6) {
            await client.runQuery("commit");
            BANKING_BREAKER.recordSuccess();
            return null;
        }
        const inserted = await client.runQuery(`insert into banking_analysis_jobs
       (id, application_id, status)
       values ($1, $2, 'pending')
       returning id, application_id, status, created_at, completed_at`, [(0, crypto_1.randomUUID)(), applicationId]);
        await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
        await client.runQuery("commit");
        const insertedRecord = inserted.rows[0];
        if (!insertedRecord) {
            throw new errors_1.AppError("data_error", "Banking analysis job not created.", 500);
        }
        BANKING_BREAKER.recordSuccess();
        return insertedRecord;
    }
    catch (err) {
        if (!(err instanceof errors_1.AppError) ||
            !["retry_backoff", "retry_exhausted"].includes(err.code)) {
            BANKING_BREAKER.recordFailure();
        }
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markBankingAnalysisCompleted(applicationId) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const existing = await client.runQuery(`select id, application_id, status, created_at, completed_at
       from banking_analysis_jobs
       where application_id = $1
       for update`, [applicationId]);
        if (existing.rows.length === 0) {
            throw new errors_1.AppError("not_found", "Banking analysis job not found.", 404);
        }
        const alreadyCompleted = existing.rows.some((row) => row.status === "completed");
        const updatedPending = await client.runQuery(`update banking_analysis_jobs
       set status = 'completed', completed_at = now()
       where application_id = $1 and status = 'pending'
       returning id, application_id, status, created_at, completed_at`, [applicationId]);
        if (updatedPending.rows.length > 0 || alreadyCompleted) {
            await client.runQuery(`update applications
         set banking_completed_at = coalesce(banking_completed_at, now()),
             updated_at = now()
         where id = $1`, [applicationId]);
        }
        await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
        const updated = await client.runQuery(`select id, application_id, status, created_at, completed_at
       from banking_analysis_jobs
       where application_id = $1`, [applicationId]);
        await client.runQuery("commit");
        return updated.rows;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markBankingAnalysisFailed(applicationId) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const existing = await client.runQuery(`select id, application_id, status, created_at, completed_at
       from banking_analysis_jobs
       where application_id = $1
       for update`, [applicationId]);
        if (existing.rows.length === 0) {
            throw new errors_1.AppError("not_found", "Banking analysis job not found.", 404);
        }
        await client.runQuery(`update banking_analysis_jobs
       set status = 'failed', completed_at = now()
       where application_id = $1 and status = 'pending'`, [applicationId]);
        const updated = await client.runQuery(`select id, application_id, status, created_at, completed_at
       from banking_analysis_jobs
       where application_id = $1`, [applicationId]);
        await client.runQuery("commit");
        return updated.rows;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
