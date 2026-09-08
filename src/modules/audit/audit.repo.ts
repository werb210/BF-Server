import { pool, runQuery } from "../../db.js";
import { type PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type AuditEventRecord = {
  id: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  action: string;
  ip: string | null;
  user_agent: string | null;
  request_id: string | null;
  success: boolean;
  created_at: Date;
  // BF_SERVER_AUDIT_METADATA_v1 - the column existed and was written to, but
  // was never selected. Service attribution (principal/service) lives here, so
  // every consumer saw agent actions as indistinguishable from human ones.
  metadata: Record<string, unknown> | null;
};

export async function listAuditEvents(params: {
  actorUserId?: string | null;
  targetUserId?: string | null;
  action?: string | null;
  /** "service" returns only agent/dialer actions; "human" excludes them. */
  principal?: "service" | "human" | null;
  from?: Date | null;
  to?: Date | null;
  limit: number;
  offset: number;
  client?: Queryable;
}): Promise<AuditEventRecord[]> {
  const runner = params.client ?? pool;
  const clauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.actorUserId) {
    clauses.push(`actor_user_id = $${idx++}`);
    values.push(params.actorUserId);
  }
  if (params.targetUserId) {
    clauses.push(`target_user_id = $${idx++}`);
    values.push(params.targetUserId);
  }
  if (params.action) {
    clauses.push(`event_action = $${idx++}`);
    values.push(params.action);
  }
  if (params.principal === "service") {
    clauses.push(`metadata->>'principal' = 'service'`);
  } else if (params.principal === "human") {
    clauses.push(`(metadata->>'principal' is distinct from 'service')`);
  }
  if (params.from) {
    clauses.push(`created_at >= $${idx++}`);
    values.push(params.from);
  }
  if (params.to) {
    clauses.push(`created_at <= $${idx++}`);
    values.push(params.to);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";

  values.push(params.limit);
  values.push(params.offset);

  const res = await runner.query<AuditEventRecord>(
    `select id,
            actor_user_id,
            target_user_id,
            event_action as action,
            ip_address as ip,
            user_agent,
            request_id,
            success,
            created_at,
            metadata
     from audit_events
     ${where}
     order by created_at desc
     limit $${idx++} offset $${idx++}`,
    values
  );
  return res.rows;
}
