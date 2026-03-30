"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDocumentProcessingJob = createDocumentProcessingJob;
exports.listBankStatementDocuments = listBankStatementDocuments;
exports.createBankingAnalysisJob = createBankingAnalysisJob;
exports.updateDocumentProcessingJob = updateDocumentProcessingJob;
exports.updateBankingAnalysisJob = updateBankingAnalysisJob;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function createDocumentProcessingJob(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into document_processing_jobs
     (id, application_id, document_id, job_type, status, created_at, updated_at)
     values ($1, (select application_id from documents where id = $2), $2, $3, $4, now(), now())
     on conflict (document_id, job_type)
     do update set updated_at = document_processing_jobs.updated_at
     returning id, document_id, job_type, status, started_at, completed_at, error_message,
               retry_count, last_retry_at, max_retries, created_at, updated_at`, [(0, crypto_1.randomUUID)(), params.documentId, params.jobType, params.status ?? "pending"]);
    const record = res.rows[0];
    if (!record) {
        throw new Error("Failed to create document processing job.");
    }
    return record;
}
async function listBankStatementDocuments(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id, status
     from documents
     where application_id = $1
       and document_type = any($2::text[])`, [params.applicationId, params.documentTypes]);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function createBankingAnalysisJob(params) {
    const runner = params.client ?? db_1.pool;
    const existing = await runner.query(`select id, application_id, status, statement_months_detected, started_at, completed_at,
            error_message, retry_count, last_retry_at, max_retries, created_at, updated_at
     from banking_analysis_jobs
     where application_id = $1
     limit 1`, [params.applicationId]);
    const existingRecord = existing.rows[0];
    if (existingRecord) {
        return existingRecord;
    }
    const res = await runner.query(`insert into banking_analysis_jobs
     (id, application_id, status, created_at, updated_at)
     values ($1, $2, $3, now(), now())
     returning id, application_id, status, statement_months_detected, started_at, completed_at,
               error_message, retry_count, last_retry_at, max_retries, created_at, updated_at`, [(0, crypto_1.randomUUID)(), params.applicationId, params.status ?? "pending"]);
    const record = res.rows[0];
    if (!record) {
        throw new Error("Failed to create banking analysis job.");
    }
    return record;
}
async function updateDocumentProcessingJob(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update document_processing_jobs
     set status = $3,
         completed_at = $4,
         error_message = $5,
         updated_at = now()
     where document_id = $1 and job_type = $2
     returning id, document_id, job_type, status, started_at, completed_at, error_message,
               retry_count, last_retry_at, max_retries, created_at, updated_at`, [
        params.documentId,
        params.jobType,
        params.status,
        params.completedAt ?? null,
        params.errorMessage ?? null,
    ]);
    return res.rows[0] ?? null;
}
async function updateBankingAnalysisJob(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update banking_analysis_jobs
     set status = $2,
         statement_months_detected = $3,
         completed_at = $4,
         error_message = $5,
         updated_at = now()
     where application_id = $1
     returning id, application_id, status, statement_months_detected, started_at, completed_at,
               error_message, retry_count, last_retry_at, max_retries, created_at, updated_at`, [
        params.applicationId,
        params.status,
        params.monthsDetected ?? null,
        params.completedAt ?? null,
        params.errorMessage ?? null,
    ]);
    return res.rows[0] ?? null;
}
