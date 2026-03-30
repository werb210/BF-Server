"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCommunications = listCommunications;
exports.listMessages = listMessages;
const db_1 = require("../../db");
async function listCommunications(params) {
    const runner = params.client ?? db_1.pool;
    const values = [];
    const conditions = [];
    if (params.contactId) {
        values.push(params.contactId);
        conditions.push(`c.contact_id = $${values.length}`);
    }
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const result = await runner.query(`
      select
        c.id,
        c.type,
        c.direction,
        c.status,
        c.duration,
        c.twilio_sid,
        c.contact_id,
        c.user_id,
        c.created_at,
        contact.id as contact_record_id,
        contact.email as contact_email,
        contact.phone as contact_phone,
        owner.id as user_record_id,
        owner.email as user_email,
        owner.phone as user_phone
      from communications c
      left join contacts contact on contact.id = c.contact_id
      left join users owner on owner.id = c.user_id
      ${whereClause}
      order by c.created_at desc nulls last
    `, values);
    if (!result.rows.length) {
        return [];
    }
    return result.rows;
}
async function listMessages(params) {
    const runner = params.client ?? db_1.pool;
    const values = [];
    const conditions = [];
    if (params.contactId) {
        values.push(params.contactId);
        conditions.push(`m.contact_id = $${values.length}`);
    }
    const offset = Math.max(params.page - 1, 0) * params.pageSize;
    values.push(params.pageSize);
    values.push(offset);
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const result = await runner.query(`
      select
        m.id,
        m.type,
        m.direction,
        m.status,
        m.duration,
        m.twilio_sid,
        m.contact_id,
        m.user_id,
        m.created_at,
        m.body,
        contact.id as contact_record_id,
        contact.email as contact_email,
        contact.phone as contact_phone,
        owner.id as user_record_id,
        owner.email as user_email,
        owner.phone as user_phone,
        count(*) over()::int as total_count
      from communications_messages m
      left join contacts contact on contact.id = m.contact_id
      left join users owner on owner.id = m.user_id
      ${whereClause}
      order by m.created_at desc nulls last
      limit $${values.length - 1}
      offset $${values.length}
    `, values);
    if (!result.rows.length) {
        return [];
    }
    return result.rows;
}
