"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureCreditSummaryJob = ensureCreditSummaryJob;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const errors_1 = require("../../middleware/errors");
const circuitBreaker_1 = require("../../utils/circuitBreaker");
const config_1 = require("../../config");
const retryPolicy_1 = require("./retryPolicy");
const CREDIT_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("credit_summary_generation", {
    failureThreshold: 3,
    cooldownMs: 60_000,
});
async function ensureCreditSummaryJob(params) {
    if (!CREDIT_BREAKER.canRequest()) {
        throw new errors_1.AppError("circuit_open", "Credit summary circuit breaker is open.", 503);
    }
    const runner = params.client ?? db_1.pool;
    const existing = await runner.query(`select id, application_id, status, retry_count, last_retry_at, max_retries,
            started_at, completed_at, error_message, created_at, updated_at
     from credit_summary_jobs
     where application_id = $1
     limit 1`, [params.applicationId]);
    if (existing.rows[0]) {
        const existingRecord = existing.rows[0];
        if (config_1.config.flags.retryPolicyEnabled && existingRecord.status === "failed") {
            const retryCount = existingRecord.retry_count ?? 0;
            const maxRetries = existingRecord.max_retries ?? 1;
            (0, retryPolicy_1.assertRetryAllowed)({
                retryCount,
                maxRetries,
                lastRetryAt: existingRecord.last_retry_at ?? null,
                baseDelayMs: 30_000,
            });
            const updated = await runner.query(`update credit_summary_jobs
         set status = 'pending',
             retry_count = retry_count + 1,
             last_retry_at = now(),
             updated_at = now(),
             completed_at = null,
             error_message = null
         where id = $1
         returning id, application_id, status, retry_count, last_retry_at, max_retries,
                   started_at, completed_at, error_message, created_at, updated_at`, [existingRecord.id]);
            CREDIT_BREAKER.recordSuccess();
            return updated.rows[0] ?? existingRecord;
        }
        CREDIT_BREAKER.recordSuccess();
        return existingRecord;
    }
    const res = await runner.query(`insert into credit_summary_jobs
     (id, application_id, status, created_at, updated_at)
     values ($1, $2, 'pending', now(), now())
     returning id, application_id, status, retry_count, last_retry_at, max_retries,
               started_at, completed_at, error_message, created_at, updated_at`, [(0, crypto_1.randomUUID)(), params.applicationId]);
    const record = res.rows[0];
    if (!record) {
        CREDIT_BREAKER.recordFailure();
        throw new errors_1.AppError("data_error", "Credit summary job not created.", 500);
    }
    CREDIT_BREAKER.recordSuccess();
    return record;
}
