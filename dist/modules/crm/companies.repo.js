"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listCompanies = listCompanies;
exports.findCompanyById = findCompanyById;
exports.createCompany = createCompany;
const db_1 = require("../../db");
async function listCompanies(params) {
    const runner = params?.client ?? db_1.pool;
    const result = await runner.query(`
      select
        c.id,
        c.name,
        c.website,
        c.email,
        c.phone,
        c.status,
        c.owner_id,
        c.referrer_id,
        owner.id as owner_record_id,
        owner.email as owner_email,
        owner.phone as owner_phone
      from companies c
      left join users owner on owner.id = c.owner_id
      order by c.id
    `);
    return result.rows.length > 0 ? result.rows : [];
}
async function findCompanyById(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`
      select
        c.id,
        c.name,
        c.website,
        c.email,
        c.phone,
        c.status,
        c.owner_id,
        c.referrer_id,
        owner.id as owner_record_id,
        owner.email as owner_email,
        owner.phone as owner_phone
      from companies c
      left join users owner on owner.id = c.owner_id
      where c.id = $1
      limit 1
    `, [params.companyId]);
    const record = result.rows[0];
    return record ?? null;
}
async function createCompany(params) {
    const runner = params.client ?? db_1.pool;
    const result = await runner.query(`
      insert into companies
      (id, name, website, email, phone, status, owner_id, referrer_id, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
      returning id, name, website, email, phone, status, owner_id, referrer_id,
                null::uuid as owner_record_id, null::text as owner_email, null::text as owner_phone
    `, [
        params.id,
        params.name,
        params.website,
        params.email,
        params.phone,
        params.status,
        params.ownerId,
        params.referrerId,
    ]);
    const record = result.rows[0];
    if (!record) {
        throw new Error("Failed to create company.");
    }
    return record;
}
