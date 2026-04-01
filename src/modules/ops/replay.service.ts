import { randomUUID } from "crypto";
import { pool } from "../../db";
import { logError } from "../../observability/logger";
import { isKillSwitchEnabled } from "./ops.service";

export const REPLAY_SCOPES = [
  "audit_events",
  "lender_submissions",
  "reporting_daily_metrics",
] as const;

export type ReplayScope = (typeof REPLAY_SCOPES)[number];

const BATCH_SIZE = 100;

function assertScope(scope: string): asserts scope is ReplayScope {
  if (!REPLAY_SCOPES.includes(scope as ReplayScope)) {
    throw new Error(`unsupported_replay_scope:${scope}`);
  }
}

async function fetchBatch(scope: ReplayScope): Promise<string[]> {
  if (scope === "audit_events") {
    const result = await pool.runQuery<{ id: string }>(
      `select id
       from audit_events
       where id not in (
         select source_id
         from ops_replay_events
         where source_table = 'audit_events'
       )
       limit $1`,
      [BATCH_SIZE]
    );
    return result.rows.map((row) => row.id);
  }
  if (scope === "lender_submissions") {
    const result = await pool.runQuery<{ id: string }>(
      `select id
       from lender_submissions
       where id not in (
         select source_id
         from ops_replay_events
         where source_table = 'lender_submissions'
       )
       limit $1`,
      [BATCH_SIZE]
    );
    return result.rows.map((row) => row.id);
  }
  const result = await pool.runQuery<{ id: string }>(
    `select id
     from reporting_daily_metrics
     where id not in (
       select source_id
       from ops_replay_events
       where source_table = 'reporting_daily_metrics'
     )
     limit $1`,
    [BATCH_SIZE]
  );
  return result.rows.map((row) => row.id);
}

async function insertReplayEvents(
  replayJobId: string,
  scope: ReplayScope,
  sourceIds: string[]
): Promise<void> {
  if (sourceIds.length === 0) {
    return;
  }
  const insertValues = sourceIds
    .map((_id, index) => {
      const offset = index * 5;
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
    })
    .join(", ");
  const insertParams: Array<string | Date> = [];
  sourceIds.forEach((id) => {
    insertParams.push(randomUUID(), replayJobId, scope, id, new Date());
  });
  await pool.runQuery(
    `insert into ops_replay_events
     (id, replay_job_id, source_table, source_id, processed_at)
     values ${insertValues}
     on conflict (source_table, source_id) do nothing`,
    insertParams
  );
}

export async function createReplayJob(scope: string): Promise<{
  id: string;
  scope: ReplayScope;
  status: string;
}> {
  assertScope(scope);
  const id = randomUUID();
  await pool.runQuery(
    `insert into ops_replay_jobs (id, scope, started_at, completed_at, status)
     values ($1, $2, null, null, 'queued')`,
    [id, scope]
  );
  return { id, scope, status: "queued" };
}

export async function fetchReplayJobStatus(
  id: string
): Promise<{ id: string; scope: ReplayScope; status: string; startedAt: string | null; completedAt: string | null } | null> {
  const result = await pool.runQuery<{
    id: string;
    scope: ReplayScope;
    status: string;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `select id, scope, status, started_at, completed_at
     from ops_replay_jobs
     where id = $1`,
    [id]
  );
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

export async function listActiveReplayJobs(): Promise<
  Array<{ id: string; scope: ReplayScope; status: string; startedAt: string | null }>
> {
  const result = await pool.runQuery<{
    id: string;
    scope: ReplayScope;
    status: string;
    started_at: Date | null;
  }>(
    `select id, scope, status, started_at
     from ops_replay_jobs
     where status in ('queued', 'running')
     order by started_at nulls first, id asc`
  );
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
  }));
}

export async function runReplayJob(id: string, scope: ReplayScope): Promise<void> {
  const startedAt = new Date();
  await pool.runQuery(
    `update ops_replay_jobs
     set status = 'running', started_at = $2
     where id = $1`,
    [id, startedAt]
  );

  try {
    if (await isKillSwitchEnabled("replay")) {
      await pool.runQuery(
        `update ops_replay_jobs
         set status = 'aborted', completed_at = now()
         where id = $1`,
        [id]
      );
      return;
    }

    while (true) {
      if (await isKillSwitchEnabled("replay")) {
        await pool.runQuery(
          `update ops_replay_jobs
           set status = 'aborted', completed_at = now()
           where id = $1`,
          [id]
        );
        return;
      }
      const batch = await fetchBatch(scope);
      if (batch.length === 0) {
        break;
      }
      await insertReplayEvents(id, scope, batch);
    }

    await pool.runQuery(
      `update ops_replay_jobs
       set status = 'completed', completed_at = now()
       where id = $1`,
      [id]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    logError("replay_failed", { code: "replay_failed", message });
    await pool.runQuery(
      `update ops_replay_jobs
       set status = 'failed', completed_at = now()
       where id = $1`,
      [id]
    );
  }
}
