"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPLAY_SCOPES = void 0;
exports.createReplayJob = createReplayJob;
exports.fetchReplayJobStatus = fetchReplayJobStatus;
exports.listActiveReplayJobs = listActiveReplayJobs;
exports.runReplayJob = runReplayJob;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const logger_1 = require("../../observability/logger");
const ops_service_1 = require("./ops.service");
exports.REPLAY_SCOPES = [
    "audit_events",
    "lender_submissions",
    "reporting_daily_metrics",
];
const BATCH_SIZE = 100;
function assertScope(scope) {
    if (!exports.REPLAY_SCOPES.includes(scope)) {
        throw new Error(`unsupported_replay_scope:${scope}`);
    }
}
async function fetchBatch(scope) {
    if (scope === "audit_events") {
        const result = await db_1.pool.query(`select id
       from audit_events
       where id not in (
         select source_id
         from ops_replay_events
         where source_table = 'audit_events'
       )
       limit $1`, [BATCH_SIZE]);
        return result.rows.map((row) => row.id);
    }
    if (scope === "lender_submissions") {
        const result = await db_1.pool.query(`select id
       from lender_submissions
       where id not in (
         select source_id
         from ops_replay_events
         where source_table = 'lender_submissions'
       )
       limit $1`, [BATCH_SIZE]);
        return result.rows.map((row) => row.id);
    }
    const result = await db_1.pool.query(`select id
     from reporting_daily_metrics
     where id not in (
       select source_id
       from ops_replay_events
       where source_table = 'reporting_daily_metrics'
     )
     limit $1`, [BATCH_SIZE]);
    return result.rows.map((row) => row.id);
}
async function insertReplayEvents(replayJobId, scope, sourceIds) {
    if (sourceIds.length === 0) {
        return;
    }
    const insertValues = sourceIds
        .map((_id, index) => {
        const offset = index * 5;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    })
        .join(", ");
    const insertParams = [];
    sourceIds.forEach((id) => {
        insertParams.push((0, crypto_1.randomUUID)(), replayJobId, scope, id, new Date());
    });
    await db_1.pool.query(`insert into ops_replay_events
     (id, replay_job_id, source_table, source_id, processed_at)
     values ${insertValues}
     on conflict (source_table, source_id) do nothing`, insertParams);
}
async function createReplayJob(scope) {
    assertScope(scope);
    const id = (0, crypto_1.randomUUID)();
    await db_1.pool.query(`insert into ops_replay_jobs (id, scope, started_at, completed_at, status)
     values ($1, $2, null, null, 'queued')`, [id, scope]);
    return { id, scope, status: "queued" };
}
async function fetchReplayJobStatus(id) {
    const result = await db_1.pool.query(`select id, scope, status, started_at, completed_at
     from ops_replay_jobs
     where id = $1`, [id]);
    const row = result.rows[0];
    if (!row) {
        return null;
    }
    return {
        id: row.id,
        scope: row.scope,
        status: row.status,
        startedAt: row.started_at ? row.started_at.toISOString() : null,
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    };
}
async function listActiveReplayJobs() {
    const result = await db_1.pool.query(`select id, scope, status, started_at
     from ops_replay_jobs
     where status in ('queued', 'running')
     order by started_at nulls first, id asc`);
    return result.rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        status: row.status,
        startedAt: row.started_at ? row.started_at.toISOString() : null,
    }));
}
async function runReplayJob(id, scope) {
    const startedAt = new Date();
    await db_1.pool.query(`update ops_replay_jobs
     set status = 'running', started_at = $2
     where id = $1`, [id, startedAt]);
    try {
        if (await (0, ops_service_1.isKillSwitchEnabled)("replay")) {
            await db_1.pool.query(`update ops_replay_jobs
         set status = 'aborted', completed_at = now()
         where id = $1`, [id]);
            return;
        }
        while (true) {
            if (await (0, ops_service_1.isKillSwitchEnabled)("replay")) {
                await db_1.pool.query(`update ops_replay_jobs
           set status = 'aborted', completed_at = now()
           where id = $1`, [id]);
                return;
            }
            const batch = await fetchBatch(scope);
            if (batch.length === 0) {
                break;
            }
            await insertReplayEvents(id, scope, batch);
        }
        await db_1.pool.query(`update ops_replay_jobs
       set status = 'completed', completed_at = now()
       where id = $1`, [id]);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        (0, logger_1.logError)("replay_failed", { code: "replay_failed", message });
        await db_1.pool.query(`update ops_replay_jobs
       set status = 'failed', completed_at = now()
       where id = $1`, [id]);
    }
}
