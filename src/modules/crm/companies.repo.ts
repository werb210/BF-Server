import { type PoolClient } from "pg";
import { pool } from "../../db";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type CompanyRepoRow = {
  id: string;
  name: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  owner_id: string | null;
  referrer_id: string | null;
  owner_record_id: string | null;
  owner_email: string | null;
  owner_phone: string | null;
};

export async function listCompanies(params?: {
  client?: Queryable;
}): Promise<CompanyRepoRow[]> {
  const runner = params?.client ?? pool;
  const result = await runner.query<CompanyRepoRow>(
    `
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
    `
  );

  return result.rows.length > 0 ? result.rows : [];
}

export async function findCompanyById(params: {
  companyId: string;
  client?: Queryable;
}): Promise<CompanyRepoRow | null> {
  const runner = params.client ?? pool;
  const result = await runner.query<CompanyRepoRow>(
    `
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
    `,
    [params.companyId]
  );

  const record = result.rows[0];
  return record ?? null;
}

export async function createCompany(params: {
  id: string;
  name: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  ownerId: string | null;
  referrerId: string | null;
  client?: Queryable;
}): Promise<CompanyRepoRow> {
  const runner = params.client ?? pool;
  const result = await runner.query<CompanyRepoRow>(
    `
      insert into companies
      (id, name, website, email, phone, status, owner_id, referrer_id, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
      returning id, name, website, email, phone, status, owner_id, referrer_id,
                null::uuid as owner_record_id, null::text as owner_email, null::text as owner_phone
    `,
    [
      params.id,
      params.name,
      params.website,
      params.email,
      params.phone,
      params.status,
      params.ownerId,
      params.referrerId,
    ]
  );

  const record = result.rows[0];
  if (!record) {
    throw new Error("Failed to create company.");
  }
  return record;
}
