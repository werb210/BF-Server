"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordAuditEvent = recordAuditEvent;
const db_1 = require("../../db");
const requestContext_1 = require("../../observability/requestContext");
async function recordAuditEvent(params) {
    const runner = params.client ?? db_1.pool;
    const requestId = params.requestId ?? (0, requestContext_1.fetchRequestId)() ?? null;
    const eventType = params.eventType ?? params.action;
    const eventAction = params.eventAction ?? params.action;
    const metadata = params.metadata === undefined || params.metadata === null
        ? null
        : JSON.stringify(params.metadata);
    await runner.query(`insert into audit_events
     (actor_user_id, target_user_id, target_type, target_id, event_type, event_action, ip_address, user_agent, request_id, success, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
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
    ]);
}
