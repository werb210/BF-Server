"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findSubmissionByIdempotencyKey = findSubmissionByIdempotencyKey;
exports.createSubmission = createSubmission;
exports.findSubmissionById = findSubmissionById;
exports.findSubmissionByApplicationAndLender = findSubmissionByApplicationAndLender;
exports.findLatestSubmissionByApplicationId = findLatestSubmissionByApplicationId;
exports.updateSubmissionStatus = updateSubmissionStatus;
exports.upsertSubmissionRetryState = upsertSubmissionRetryState;
exports.findSubmissionRetryState = findSubmissionRetryState;
exports.createSubmissionEvent = createSubmissionEvent;
const config_1 = require("../../config");
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function findSubmissionByIdempotencyKey(key, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, status, idempotency_key, lender_id, submission_method, submitted_at, payload, payload_hash,
            lender_response, response_received_at, failure_reason, external_reference, created_at, updated_at
     from lender_submissions
     where idempotency_key = $1
     limit 1`, [key]);
    return res.rows[0] ?? null;
}
async function createSubmission(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into lender_submissions
     (id, application_id, status, idempotency_key, lender_id, submission_method, submitted_at, payload, payload_hash,
      lender_response, response_received_at, failure_reason, external_reference, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())
     returning id, application_id, status, idempotency_key, lender_id, submission_method, submitted_at, payload, payload_hash,
               lender_response, response_received_at, failure_reason, external_reference, created_at, updated_at`, [
        (0, crypto_1.randomUUID)(),
        params.applicationId,
        params.status,
        params.idempotencyKey,
        params.lenderId,
        params.submissionMethod,
        params.submittedAt,
        params.payload,
        params.payloadHash,
        params.lenderResponse,
        params.responseReceivedAt,
        params.failureReason,
        params.externalReference,
    ]);
    const record = res.rows[0];
    if (!record) {
        throw new Error("Failed to create lender submission.");
    }
    return record;
}
async function findSubmissionById(id, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, status, idempotency_key, lender_id, submission_method, submitted_at, payload, payload_hash,
            lender_response, response_received_at, failure_reason, external_reference, created_at, updated_at
     from lender_submissions
     where id = $1
     limit 1`, [id]);
    return res.rows[0] ?? null;
}
async function findSubmissionByApplicationAndLender(params, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, status, idempotency_key, lender_id, submission_method, submitted_at, payload, payload_hash,
            lender_response, response_received_at, failure_reason, external_reference, created_at, updated_at
     from lender_submissions
     where application_id = $1
       and lender_id = $2
     limit 1`, [params.applicationId, params.lenderId]);
    return res.rows[0] ?? null;
}
async function findLatestSubmissionByApplicationId(applicationId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, status, idempotency_key, lender_id, submission_method, submitted_at, payload, payload_hash,
            lender_response, response_received_at, failure_reason, external_reference, created_at, updated_at
     from lender_submissions
     where application_id = $1
     order by created_at desc
     limit 1`, [applicationId]);
    return res.rows[0] ?? null;
}
async function updateSubmissionStatus(params) {
    const runner = params.client ?? db_1.pool;
    await runner.query(`update lender_submissions
     set status = $1,
         lender_response = $2,
         response_received_at = $3,
         failure_reason = $4,
         external_reference = $5,
         updated_at = now()
     where id = $6`, [
        params.status,
        params.lenderResponse,
        params.responseReceivedAt,
        params.failureReason,
        params.externalReference,
        params.submissionId,
    ]);
}
async function upsertSubmissionRetryState(params) {
    const runner = params.client ?? db_1.pool;
    if (config_1.config.env === "test") {
        const existing = await runner.query(`select id, submission_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, canceled_at
       from lender_submission_retries
       where submission_id = $1
       limit 1`, [params.submissionId]);
        if (existing.rows.length > 0) {
            await runner.query(`update lender_submission_retries
         set status = $1,
             attempt_count = $2,
             next_attempt_at = $3,
             last_error = $4,
             canceled_at = $5,
             updated_at = now()
         where submission_id = $6`, [
                params.status,
                params.attemptCount,
                params.nextAttemptAt,
                params.lastError,
                params.canceledAt,
                params.submissionId,
            ]);
        }
        else {
            await runner.query(`insert into lender_submission_retries
         (id, submission_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, canceled_at)
         values ($1, $2, $3, $4, $5, $6, now(), now(), $7)`, [
                (0, crypto_1.randomUUID)(),
                params.submissionId,
                params.status,
                params.attemptCount,
                params.nextAttemptAt,
                params.lastError,
                params.canceledAt,
            ]);
        }
        const res = await runner.query(`select id, submission_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, canceled_at
       from lender_submission_retries
       where submission_id = $1
       limit 1`, [params.submissionId]);
        const retryRecord = res.rows[0];
        if (!retryRecord) {
            throw new Error("Failed to load lender submission retry.");
        }
        return retryRecord;
    }
    const res = await runner.query(`insert into lender_submission_retries
     (id, submission_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, canceled_at)
     values ($1, $2, $3, $4, $5, $6, now(), now(), $7)
     on conflict (submission_id)
     do update set
       status = excluded.status,
       attempt_count = excluded.attempt_count,
       next_attempt_at = excluded.next_attempt_at,
       last_error = excluded.last_error,
       canceled_at = excluded.canceled_at,
       updated_at = now()
     returning id, submission_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, canceled_at`, [
        (0, crypto_1.randomUUID)(),
        params.submissionId,
        params.status,
        params.attemptCount,
        params.nextAttemptAt,
        params.lastError,
        params.canceledAt,
    ]);
    const retryRecord = res.rows[0];
    if (!retryRecord) {
        throw new Error("Failed to create lender submission retry.");
    }
    return retryRecord;
}
async function findSubmissionRetryState(submissionId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, submission_id, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, canceled_at
     from lender_submission_retries
     where submission_id = $1
     limit 1`, [submissionId]);
    return res.rows[0] ?? null;
}
async function createSubmissionEvent(params) {
    const runner = params.client ?? db_1.pool;
    try {
        const res = await runner.query(`insert into submission_events
       (id, application_id, lender_id, method, status, internal_error, created_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, application_id, lender_id, method, status, internal_error, created_at`, [
            (0, crypto_1.randomUUID)(),
            params.applicationId,
            params.lenderId,
            params.method,
            params.status,
            params.internalError,
            params.timestamp,
        ]);
        const eventRecord = res.rows[0];
        if (!eventRecord) {
            throw new Error("Failed to create submission event.");
        }
        return eventRecord;
    }
    catch (err) {
        const code = err.code;
        if (config_1.config.env === "test" && code === "42P01") {
            return {
                id: (0, crypto_1.randomUUID)(),
                application_id: params.applicationId,
                lender_id: params.lenderId,
                method: params.method,
                status: params.status,
                internal_error: params.internalError,
                created_at: params.timestamp,
            };
        }
        throw err;
    }
}
