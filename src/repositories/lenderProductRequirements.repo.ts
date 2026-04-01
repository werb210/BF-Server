import { randomUUID } from "crypto";
import { pool } from "../db";
import { type PoolClient } from "pg";
import { type LenderProductRequirementRecord } from "../db/schema/lenderProductRequirements";

export type RequirementSeedInput = {
  documentType: string;
  required: boolean;
  minAmount?: number | null;
  maxAmount?: number | null;
};

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export async function listLenderProductRequirements(params: {
  lenderProductId: string;
  requestedAmount?: number | null;
  client?: Queryable;
}): Promise<LenderProductRequirementRecord[]> {
  const runner = params.client ?? pool;
  const requestedAmount = params.requestedAmount ?? null;
  const res = await runner.query<LenderProductRequirementRecord>(
    `select id,
            lender_product_id,
            document_type,
            required,
            min_amount,
            max_amount,
            created_at
     from lender_product_requirements
     where lender_product_id = $1
       and ($2::int is null
            or ((min_amount is null or $2 >= min_amount)
                and (max_amount is null or $2 <= max_amount)))
     order by created_at asc`,
    [params.lenderProductId, requestedAmount]
  );
  return res.rows;
}

export async function fetchLenderProductRequirementById(params: {
  id: string;
  client?: Queryable;
}): Promise<LenderProductRequirementRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<LenderProductRequirementRecord>(
    `select id,
            lender_product_id,
            document_type,
            required,
            min_amount,
            max_amount,
            created_at
     from lender_product_requirements
     where id = $1
     limit 1`,
    [params.id]
  );
  return res.rows[0] ?? null;
}

export async function countLenderProductRequirements(params: {
  lenderProductId: string;
  client?: Queryable;
}): Promise<number> {
  const runner = params.client ?? pool;
  const res = await runner.query<{ count: number }>(
    "select count(*)::int as count from lender_product_requirements where lender_product_id = $1",
    [params.lenderProductId]
  );
  return res.rows[0]?.count ?? 0;
}

export async function countRequiredLenderProductRequirements(params: {
  lenderProductId: string;
  client?: Queryable;
}): Promise<number> {
  const runner = params.client ?? pool;
  const res = await runner.query<{ count: number }>(
    "select count(*)::int as count from lender_product_requirements where lender_product_id = $1 and required = true",
    [params.lenderProductId]
  );
  return res.rows[0]?.count ?? 0;
}

export async function createLenderProductRequirement(params: {
  lenderProductId: string;
  documentType: string;
  required: boolean;
  minAmount?: number | null;
  maxAmount?: number | null;
  client?: Queryable;
}): Promise<LenderProductRequirementRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<LenderProductRequirementRecord>(
    `insert into lender_product_requirements
     (id, lender_product_id, document_type, required, min_amount, max_amount, created_at)
     values ($1, $2, $3, $4, $5, $6, now())
     returning id, lender_product_id, document_type, required, min_amount, max_amount, created_at`,
    [
      randomUUID(),
      params.lenderProductId,
      params.documentType,
      params.required,
      params.minAmount ?? null,
      params.maxAmount ?? null,
    ]
  );
  const record = res.rows[0];
  if (!record) {
    throw new Error("Failed to create lender product requirement.");
  }
  return record;
}

export async function updateLenderProductRequirement(params: {
  id: string;
  documentType: string;
  required: boolean;
  minAmount?: number | null;
  maxAmount?: number | null;
  client?: Queryable;
}): Promise<LenderProductRequirementRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<LenderProductRequirementRecord>(
    `update lender_product_requirements
     set document_type = $1,
         required = $2,
         min_amount = $3,
         max_amount = $4
     where id = $5
     returning id, lender_product_id, document_type, required, min_amount, max_amount, created_at`,
    [params.documentType, params.required, params.minAmount ?? null, params.maxAmount ?? null, params.id]
  );
  return res.rows[0] ?? null;
}

export async function deleteLenderProductRequirement(params: {
  id: string;
  client?: Queryable;
}): Promise<LenderProductRequirementRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<LenderProductRequirementRecord>(
    `delete from lender_product_requirements
     where id = $1
     returning id, lender_product_id, document_type, required, min_amount, max_amount, created_at`,
    [params.id]
  );
  return res.rows[0] ?? null;
}

export async function createRequirementSeeds(params: {
  lenderProductId: string;
  requirements: RequirementSeedInput[];
  client?: Queryable;
}): Promise<number> {
  if (params.requirements.length === 0) {
    return 0;
  }
  const runner = params.client ?? pool;
  const values: Array<string | number | boolean | null> = [];
  const placeholders = params.requirements
    .map((req, index) => {
      const offset = index * 6;
      values.push(
        randomUUID(),
        params.lenderProductId,
        req.documentType,
        req.required,
        req.minAmount ?? null,
        req.maxAmount ?? null
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, now())`;
    })
    .join(", ");

  await runner.query(
    `insert into lender_product_requirements
     (id, lender_product_id, document_type, required, min_amount, max_amount, created_at)
     values ${placeholders}`,
    values
  );

  return params.requirements.length;
}
