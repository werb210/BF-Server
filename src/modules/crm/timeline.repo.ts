import { pool } from "../../db";
import { type PoolClient } from "pg";

export type CrmTimelineRecord = {
  id: string;
  entityType: string | null;
  entityId: string | null;
  actionTaken: string;
  createdAt: Date;
  metadata: Record<string, unknown> | null;
};

type Queryable = Pick<PoolClient, "query" | "runQuery">;

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
  }
  return { raw: value } as Record<string, unknown>;
}

export async function listCrmTimeline(params: {
  entityType?: string | null;
  entityId?: string | null;
  ruleId?: string | null;
  limit: number;
  offset: number;
  client?: Queryable;
}): Promise<CrmTimelineRecord[]> {
  const runner = params.client ?? pool;
  const clauses: string[] = ["event_type = 'crm_timeline'"];
  const values: unknown[] = [];
  let idx = 1;

  if (params.entityType) {
    clauses.push(`target_type = $${idx++}`);
    values.push(params.entityType);
  }
  if (params.entityId) {
    clauses.push(`target_id = $${idx++}`);
    values.push(params.entityId);
  }
  if (params.ruleId) {
    clauses.push(`metadata->>'rule_id' = $${idx++}`);
    values.push(params.ruleId);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";

  values.push(params.limit);
  values.push(params.offset);

  const res = await runner.query<{
    id: string;
    target_type: string | null;
    target_id: string | null;
    event_action: string;
    created_at: Date;
    metadata: unknown;
  }>(
    `select id,
            target_type,
            target_id,
            event_action,
            created_at,
            metadata
     from audit_events
     ${where}
     order by created_at desc
     limit $${idx++} offset $${idx++}`,
    values
  );

  return res.rows.map((row) => ({
    id: row.id,
    entityType: row.target_type,
    entityId: row.target_id,
    actionTaken: row.event_action,
    createdAt: row.created_at,
    metadata: parseMetadata(row.metadata),
  }));
}
