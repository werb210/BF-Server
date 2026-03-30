"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findIdempotencyRecord = findIdempotencyRecord;
exports.deleteExpiredIdempotencyRecord = deleteExpiredIdempotencyRecord;
exports.purgeExpiredIdempotencyKeys = purgeExpiredIdempotencyKeys;
exports.createIdempotencyRecord = createIdempotencyRecord;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function findIdempotencyRecord(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id, key, route, request_hash, response_code, response_body, created_at
     from idempotency_keys
     where route = $1
       and key = $2
       and created_at >= (localtimestamp - interval '24 hours')
     limit 1`, [params.route, params.idempotencyKey]);
    return res.rows[0] ?? null;
}
async function deleteExpiredIdempotencyRecord(params) {
    const runner = params.client ?? db_1.pool;
    await runner.query(`delete from idempotency_keys
     where route = $1
       and key = $2
       and created_at < (localtimestamp - interval '24 hours')`, [params.route, params.idempotencyKey]);
}
async function purgeExpiredIdempotencyKeys(client) {
    const runner = client ?? db_1.pool;
    await runner.query(`delete from idempotency_keys
     where created_at < (localtimestamp - interval '24 hours')`);
}
function isUndefinedColumnError(error, column) {
    const code = error.code;
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return code === "42703" || message.includes(column.toLowerCase());
}
async function createIdempotencyRecord(params) {
    const runner = params.client ?? db_1.pool;
    const id = (0, crypto_1.randomUUID)();
    if (params.method) {
        try {
            await runner.query(`insert into idempotency_keys
         (id, key, route, method, request_hash, response_code, response_body, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, now())
         on conflict (route, key) do update
         set request_hash = excluded.request_hash,
             response_code = excluded.response_code,
             response_body = excluded.response_body,
             created_at = now()`, [
                id,
                params.idempotencyKey,
                params.route,
                params.method,
                params.requestHash,
                params.responseCode,
                params.responseBody,
            ]);
            return;
        }
        catch (error) {
            if (!isUndefinedColumnError(error, "method")) {
                throw error;
            }
        }
    }
    try {
        await runner.query(`insert into idempotency_keys
       (id, key, route, request_hash, response_code, response_body, created_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (route, key) do update
       set request_hash = excluded.request_hash,
           response_code = excluded.response_code,
           response_body = excluded.response_body,
           created_at = now()`, [
            id,
            params.idempotencyKey,
            params.route,
            params.requestHash,
            params.responseCode,
            params.responseBody,
        ]);
        return;
    }
    catch (error) {
        if (!isUndefinedColumnError(error, "request_hash") && !isUndefinedColumnError(error, "response_code") && !isUndefinedColumnError(error, "response_body") && !isUndefinedColumnError(error, "id")) {
            throw error;
        }
    }
    await runner.query(`insert into idempotency_keys
     (key, route, response, created_at)
     values ($1, $2, $3, now())
     on conflict (route, key) do update
     set response = excluded.response,
         created_at = now()`, [
        params.idempotencyKey,
        params.route,
        JSON.stringify(params.responseBody ?? null),
    ]);
}
