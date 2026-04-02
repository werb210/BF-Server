import { type PoolClient } from "pg";
import { pool, runQuery } from "../../db";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type ContactRepoRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  company_id: string | null;
  owner_id: string | null;
  referrer_id: string | null;
  company_record_id: string | null;
  company_name: string | null;
  owner_record_id: string | null;
  owner_email: string | null;
  owner_phone: string | null;
};

export async function listContacts(params: {
  companyId?: string | null;
  client?: Queryable;
}): Promise<ContactRepoRow[]> {
  const runner = params.client ?? pool;
  const values: Array<string> = [];
  const conditions: string[] = [];

  if (params.companyId) {
    values.push(params.companyId);
    conditions.push(`c.company_id = $${values.length}`);
  }

  const whereClause = conditions.length > 0 ? `where ${conditions.join(" and ")}` : "";

  const result = await runner.query<ContactRepoRow>(
    `
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
    `,
    values
  );

  return result.rows.length > 0 ? result.rows : [];
}

export async function createContact(params: {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  companyId: string | null;
  ownerId: string | null;
  referrerId: string | null;
  client?: Queryable;
}): Promise<ContactRepoRow> {
  const runner = params.client ?? pool;
  const result = await runner.query<ContactRepoRow>(
    `
      insert into contacts
      (id, name, email, phone, status, company_id, owner_id, referrer_id, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
      returning id, name, email, phone, status, company_id, owner_id, referrer_id,
                null::uuid as company_record_id, null::text as company_name,
                null::uuid as owner_record_id, null::text as owner_email, null::text as owner_phone
    `,
    [
      params.id,
      params.name,
      params.email,
      params.phone,
      params.status,
      params.companyId,
      params.ownerId,
      params.referrerId,
    ]
  );

  const record = result.rows[0];
  if (!record) {
    throw new Error("Failed to create contact.");
  }
  return record;
}
