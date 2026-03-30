"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOcrJob = createOcrJob;
exports.lockOcrJobs = lockOcrJobs;
exports.clearExpiredOcrLocks = clearExpiredOcrLocks;
exports.markOcrJobSuccess = markOcrJobSuccess;
exports.markOcrJobFailure = markOcrJobFailure;
exports.resetOcrJob = resetOcrJob;
exports.findOcrJobByDocumentId = findOcrJobByDocumentId;
exports.findOcrResultByDocumentId = findOcrResultByDocumentId;
exports.insertDocumentOcrFields = insertDocumentOcrFields;
exports.listOcrResultsForApplication = listOcrResultsForApplication;
exports.listOcrFieldsForApplication = listOcrFieldsForApplication;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const config_1 = require("../../config");
async function createOcrJob(params) {
    const runner = params.client ?? db_1.pool;
    if (config_1.config.env === "test") {
        const existing = await runner.query(`select id, document_id, application_id, status, attempt_count, max_attempts,
              next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at
       from ocr_jobs
       where document_id = $1
       limit 1`, [params.documentId]);
        const existingRecord = existing.rows[0];
        if (existingRecord) {
            return existingRecord;
        }
        const inserted = await runner.query(`insert into ocr_jobs
       (id, document_id, application_id, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
       values ($1, $2, $3, 'queued', 0, $4, now(), now(), now())
       returning id, document_id, application_id, status, attempt_count, max_attempts,
                 next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`, [(0, crypto_1.randomUUID)(), params.documentId, params.applicationId, params.maxAttempts]);
        const insertedRecord = inserted.rows[0];
        if (!insertedRecord) {
            throw new Error("Failed to create OCR job.");
        }
        return insertedRecord;
    }
    const res = await runner.query(`insert into ocr_jobs
     (id, document_id, application_id, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
     values ($1, $2, $3, 'queued', 0, $4, now(), now(), now())
     on conflict (document_id)
     do update set updated_at = ocr_jobs.updated_at
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`, [(0, crypto_1.randomUUID)(), params.documentId, params.applicationId, params.maxAttempts]);
    const record = res.rows[0];
    if (!record) {
        throw new Error("Failed to create OCR job.");
    }
    return record;
}
async function lockOcrJobs(params) {
    const runner = params.client ?? db_1.pool;
    const lockTimeoutMinutes = config_1.config.ocr.lockTimeoutMinutes;
    const res = await runner.query(`with candidates as (
       select id
       from ocr_jobs
       where (
         (status in ('queued', 'failed') and (next_attempt_at is null or next_attempt_at <= now()::timestamp))
         or status = 'processing'
       )
         and (locked_at is null or locked_at <= now() - ($3 * interval '1 minute'))
       order by created_at asc
       limit $1
       for update skip locked
     )
     update ocr_jobs
     set status = 'processing',
         locked_at = now()::timestamp,
         locked_by = $2,
         updated_at = now()::timestamp
     where id in (select id from candidates)
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`, [params.limit, params.lockedBy, lockTimeoutMinutes]);
    return res.rows;
}
async function clearExpiredOcrLocks(params) {
    const runner = params?.client ?? db_1.pool;
    const lockTimeoutMinutes = config_1.config.ocr.lockTimeoutMinutes;
    const res = await runner.query(`update ocr_jobs
     set locked_at = null,
         locked_by = null,
         updated_at = now()
     where locked_at is not null
       and locked_at <= now() - ($1 * interval '1 minute')
     returning id`, [lockTimeoutMinutes]);
    return res.rows.length;
}
async function markOcrJobSuccess(params) {
    const runner = params.client ?? (await db_1.pool.connect());
    const release = params.client ? null : () => runner.release();
    await runner.query("begin");
    try {
        await runner.query(`insert into ocr_document_results
       (id, document_id, provider, model, extracted_text, extracted_json, meta, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now(), now())
       on conflict (document_id) do nothing`, [
            (0, crypto_1.randomUUID)(),
            params.documentId,
            params.provider,
            params.model,
            params.extractedText,
            params.extractedJson,
            params.meta,
        ]);
        await runner.query(`update ocr_jobs
       set status = 'succeeded',
           next_attempt_at = null,
           locked_at = null,
           locked_by = null,
           last_error = null,
           updated_at = now()
       where id = $1`, [params.jobId]);
        await runner.query("commit");
    }
    catch (error) {
        await runner.query("rollback");
        throw error;
    }
    finally {
        release?.();
    }
}
async function markOcrJobFailure(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update ocr_jobs
     set attempt_count = $2,
         status = $3,
         next_attempt_at = $4,
         max_attempts = $5::int,
         locked_at = null,
         locked_by = null,
         last_error = $6,
         updated_at = now()
     where id = $1
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`, [
        params.jobId,
        params.attemptCount,
        params.status,
        params.nextAttemptAt,
        params.maxAttempts,
        params.lastError,
    ]);
    return res.rows[0] ?? null;
}
async function resetOcrJob(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update ocr_jobs
     set status = 'queued',
         attempt_count = 0,
         next_attempt_at = now(),
         locked_at = null,
         locked_by = null,
         last_error = null,
         updated_at = now()
     where id = $1
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`, [params.jobId]);
    return res.rows[0] ?? null;
}
async function findOcrJobByDocumentId(documentId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, document_id, application_id, status, attempt_count, max_attempts,
            next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at
     from ocr_jobs
     where document_id = $1
     limit 1`, [documentId]);
    return res.rows[0] ?? null;
}
async function findOcrResultByDocumentId(documentId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, document_id, provider, model, extracted_text, extracted_json, meta, created_at, updated_at
     from ocr_document_results
     where document_id = $1
     order by created_at desc
     limit 1`, [documentId]);
    return res.rows[0] ?? null;
}
async function insertDocumentOcrFields(params) {
    const runner = params.client ?? db_1.pool;
    if (params.fields.length === 0) {
        return [];
    }
    const values = [];
    const placeholders = [];
    params.fields.forEach((field, index) => {
        const base = index * 7;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, now())`);
        values.push((0, crypto_1.randomUUID)(), params.applicationId, params.documentId, field.fieldKey, field.value, field.confidence, params.documentType);
    });
    const result = await runner.query(`insert into ocr_results
     (id, application_id, document_id, field_key, value, confidence, source_document_type, created_at)
     values ${placeholders.join(", ")}
     returning id, application_id, document_id, field_key, value, confidence, source_document_type, created_at`, values);
    return result.rows;
}
async function listOcrResultsForApplication(applicationId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select d.id as document_id,
            d.document_type,
            r.extracted_json
     from documents d
     left join ocr_document_results r on r.document_id = d.id
     where d.application_id = $1
     order by d.created_at asc`, [applicationId]);
    return res.rows ?? [];
}
async function listOcrFieldsForApplication(applicationId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select document_id,
            application_id,
            field_key,
            value,
            confidence,
            source_document_type,
            created_at
     from ocr_results
     where application_id = $1
     order by created_at asc`, [applicationId]);
    return res.rows ?? [];
}
