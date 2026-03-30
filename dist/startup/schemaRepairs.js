"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSchemaRepairs = ensureSchemaRepairs;
const config_1 = require("../config");
const db_1 = require("../db");
const logger_1 = require("../observability/logger");
async function ensureIdempotencyTable() {
    await db_1.pool.query(`create table if not exists idempotency_keys (
       id text primary key,
       key text not null,
       route text not null,
       method text not null default 'POST',
       request_hash text not null,
       response_code integer not null,
       response_body jsonb not null,
       created_at timestamp not null default now(),
       unique (key, route)
     )`);
}
async function fetchIdempotencyColumns() {
    const res = await db_1.pool.query(`select column_name, is_nullable, data_type
     from information_schema.columns
     where table_name = 'idempotency_keys'`);
    return new Map(res.rows.map((row) => [row.column_name, row]));
}
async function addColumnIfMissing(columns, name, definition) {
    if (columns.has(name)) {
        return;
    }
    await db_1.pool.query(`alter table idempotency_keys add column if not exists ${definition}`);
    columns.set(name, { column_name: name, is_nullable: "YES", data_type: "" });
}
async function dropNotNullIfPresent(columns, name) {
    const column = columns.get(name);
    if (!column || column.is_nullable === "YES") {
        return;
    }
    await db_1.pool.query(`alter table idempotency_keys alter column ${name} drop not null`);
    columns.set(name, { ...column, is_nullable: "YES" });
}
async function alignIdempotencySchema() {
    await ensureIdempotencyTable();
    const columns = await fetchIdempotencyColumns();
    await addColumnIfMissing(columns, "id", "id text");
    await addColumnIfMissing(columns, "key", "key text");
    await addColumnIfMissing(columns, "route", "route text");
    await addColumnIfMissing(columns, "method", "method text");
    await addColumnIfMissing(columns, "request_hash", "request_hash text");
    await addColumnIfMissing(columns, "response_code", "response_code integer");
    await addColumnIfMissing(columns, "response_body", "response_body jsonb");
    await addColumnIfMissing(columns, "created_at", "created_at timestamp");
    await dropNotNullIfPresent(columns, "actor_user_id");
    await dropNotNullIfPresent(columns, "scope");
    await dropNotNullIfPresent(columns, "idempotency_key");
    await dropNotNullIfPresent(columns, "status_code");
    if (columns.has("idempotency_key") && columns.has("key")) {
        await db_1.pool.query("update idempotency_keys set key = idempotency_key where key is null");
    }
    if (columns.has("scope") && columns.has("route")) {
        await db_1.pool.query("update idempotency_keys set route = scope where route is null");
    }
    if (columns.has("status_code") && columns.has("response_code")) {
        await db_1.pool.query("update idempotency_keys set response_code = status_code where response_code is null");
    }
    await db_1.pool.query("update idempotency_keys set request_hash = '' where request_hash is null");
    await db_1.pool.query("update idempotency_keys set response_code = 200 where response_code is null");
    await db_1.pool.query("update idempotency_keys set response_body = '{}'::jsonb where response_body is null");
    await db_1.pool.query("update idempotency_keys set created_at = now() where created_at is null");
    if (columns.has("method")) {
        await db_1.pool.query("update idempotency_keys set method = 'POST' where method is null");
        await db_1.pool.query("alter table idempotency_keys alter column method set default 'POST'");
        await db_1.pool.query("alter table idempotency_keys alter column method set not null");
    }
    const idColumn = columns.get("id");
    if (idColumn?.data_type !== "uuid") {
        await db_1.pool.query("update idempotency_keys set id = md5(coalesce(key, '') || ':' || coalesce(route, '')) where id is null");
    }
    await db_1.pool.query("alter table idempotency_keys alter column id set not null");
    await db_1.pool.query("create unique index if not exists idempotency_keys_id_unique_idx on idempotency_keys (id)");
    await db_1.pool.query("create unique index if not exists idempotency_keys_key_route_unique_idx on idempotency_keys (key, route)");
}
async function ensureSchemaRepairs() {
    if (config_1.config.env === "test") {
        return;
    }
    try {
        await alignIdempotencySchema();
        (0, logger_1.logInfo)("startup_schema_repairs_completed", { schema: "idempotency_keys" });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : "unknown_error";
        (0, logger_1.logWarn)("startup_schema_repairs_failed", {
            schema: "idempotency_keys",
            error: message,
        });
        (0, logger_1.logError)("startup_schema_repairs_exception", { error: message });
    }
}
