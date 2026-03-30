"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCrmTimeline = listCrmTimeline;
const db_1 = require("../../db");
function parseMetadata(value) {
    if (!value) {
        return null;
    }
    if (typeof value === "object") {
        return value;
    }
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        }
        catch {
            return { raw: value };
        }
    }
    return { raw: value };
}
async function listCrmTimeline(params) {
    const runner = params.client ?? db_1.pool;
    const clauses = ["event_type = 'crm_timeline'"];
    const values = [];
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
    const res = await runner.query(`select id,
            target_type,
            target_id,
            event_action,
            created_at,
            metadata
     from audit_events
     ${where}
     order by created_at desc
     limit $${idx++} offset $${idx++}`, values);
    return res.rows.map((row) => ({
        id: row.id,
        entityType: row.target_type,
        entityId: row.target_id,
        actionTaken: row.event_action,
        createdAt: row.created_at,
        metadata: parseMetadata(row.metadata),
    }));
}
