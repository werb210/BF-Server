"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findClientSubmissionByKey = findClientSubmissionByKey;
exports.createClientSubmission = createClientSubmission;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function findClientSubmissionByKey(submissionKey, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, submission_key, application_id, payload, created_at
     from client_submissions
     where submission_key = $1
     limit 1`, [submissionKey]);
    return res.rows[0] ?? null;
}
async function createClientSubmission(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into client_submissions
     (id, submission_key, application_id, payload, created_at)
     values ($1, $2, $3, $4, now())
     returning id, submission_key, application_id, payload, created_at`, [(0, crypto_1.randomUUID)(), params.submissionKey, params.applicationId, params.payload]);
    const record = res.rows[0];
    if (!record) {
        throw new Error("Failed to create client submission.");
    }
    return record;
}
