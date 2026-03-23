import { type PoolClient } from "pg";
import { pool } from "../../db";
import { fetchRequestId } from "../../observability/requestContext";

type Queryable = Pick<PoolClient, "query">;

export type AuditParams = {
  actorUserId: string | null;
  targetUserId: string | null;
  targetType?: string | null;
  targetId?: string | null;
  action: string;
  eventType?: string | null;
  eventAction?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  success: boolean;
  metadata?: Record<string, unknown> | null;
  client?: Queryable;
};

export async function recordAuditEvent(params: AuditParams): Promise<void> {
  const runner = params.client ?? pool;
  const requestId = params.requestId ?? fetchRequestId() ?? null;
  const eventType = params.eventType ?? params.action;
  const eventAction = params.eventAction ?? params.action;
  const metadata =
    params.metadata === undefined || params.metadata === null
      ? null
      : JSON.stringify(params.metadata);
  await runner.query(
    `insert into audit_events
     (actor_user_id, target_user_id, target_type, target_id, event_type, event_action, ip_address, user_agent, request_id, success, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      params.actorUserId,
      params.targetUserId,
      params.targetType ?? null,
      params.targetId ?? null,
      eventType,
      eventAction,
      params.ip ?? null,
      params.userAgent ?? null,
      requestId,
      params.success,
      metadata,
    ]
  );
}
