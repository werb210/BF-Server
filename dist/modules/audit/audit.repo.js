"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listAuditEvents = listAuditEvents;
const db_1 = require("../../db");
async function listAuditEvents(params) {
    const runner = params.client ?? db_1.pool;
    const clauses = [];
    const values = [];
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
    const res = await runner.query(`select id,
            actor_user_id,
            target_user_id,
            event_action as action,
            ip_address as ip,
            user_agent,
            request_id,
            success,
            created_at
     from audit_events
     ${where}
     order by created_at desc
     limit $${idx++} offset $${idx++}`, values);
    return res.rows;
}
