import { type PoolClient } from "pg";
import { pool, runQuery } from "../../db.js";
import { fetchRequestId, fetchRequestServiceName } from "../../observability/requestContext.js";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

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
  // BF_SERVER_SERVICE_PRINCIPAL_v1 - set from req.user for service tokens
  // (Maya, dialer). Folded into metadata so the timeline can tell an agent
  // action apart from a human one on the same Staff role, without a schema
  // change or a second actor column.
  serviceName?: string | null;
};

export async function recordAuditEvent(params: AuditParams): Promise<void> {
  const runner = params.client ?? pool;
  const requestId = params.requestId ?? fetchRequestId() ?? null;
  const eventType = params.eventType ?? params.action;
  const eventAction = params.eventAction ?? params.action;
  // BF_SERVER_AUDIT_PRINCIPAL_CONTEXT_v1 - explicit argument wins; otherwise
  // fall back to the request store, so untouched call sites attribute too.
  const serviceName = params.serviceName ?? fetchRequestServiceName();
  const enriched = serviceName
    ? { ...(params.metadata ?? {}), principal: "service", service: serviceName }
    : params.metadata;
  const metadata =
    enriched === undefined || enriched === null
      ? null
      : JSON.stringify(enriched);
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
