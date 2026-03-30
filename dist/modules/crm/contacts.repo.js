"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listContacts = listContacts;
exports.createContact = createContact;
const db_1 = require("../../db");
async function listContacts(params) {
    const runner = params.client ?? db_1.pool;
    const values = [];
    const conditions = [];
    if (params.companyId) {
        values.push(params.companyId);
        conditions.push(`c.company_id = $${values.length}`);
    }
    const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";
    const result = await runner.query(`
      select
        c.id,
        c.name,
        c.email,
        c.phone,
        c.status,
        c.company_id,
        c.owner_id,
        c.referrer_id,
        company.id as company_record_id,
        company.name as company_name,
        owner.id as owner_record_id,
        owner.email as owner_email,
        owner.phone as owner_phone
      from contacts c
      left join companies company on company.id = c.company_id
      left join users owner on owner.id = c.owner_id
      ${whereClause}
      order by c.id
    `, values);
    return result.rows.length > 0 ? result.rows : [];
}
async function createContact(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`
      insert into contacts
      (id, name, email, phone, status, company_id, owner_id, referrer_id, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
      returning id, name, email, phone, status, company_id, owner_id, referrer_id,
                null::uuid as company_record_id, null::text as company_name,
                null::uuid as owner_record_id, null::text as owner_email, null::text as owner_phone
    `, [
        params.id,
        params.name,
        params.email,
        params.phone,
        params.status,
        params.companyId,
        params.ownerId,
        params.referrerId,
    ]);
    const record = result.rows[0];
    if (!record) {
        throw new Error("Failed to create contact.");
    }
    return record;
}
