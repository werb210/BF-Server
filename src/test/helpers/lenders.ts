import { randomUUID } from "crypto";
import { pool } from "../../db";

type SeedLenderProductParams = {
  category: string;
  country: string;
  requiredDocuments: Array<{
    type: string;
    required?: boolean;
    months?: number;
  }>;
};

export async function seedLenderProduct(params: SeedLenderProductParams): Promise<{
  lenderId: string;
  productId: string;
}> {
  await pool.query(
    `update lender_products
     set active = false,
         updated_at = now()
     where category = $1
       and country = $2`,
    [params.category, params.country]
  );
  const lenderId = randomUUID();
  const productId = randomUUID();
  const lenderName = `Test Lender ${lenderId}`;
  await pool.query(
    `insert into lenders
     (id, name, country, submission_method, active, created_at, updated_at)
     values ($1, $3, $2, 'api', true, now(), now())`,
    [lenderId, params.country, lenderName]
  );
  await pool.query(
    `insert into lender_products
     (id, lender_id, name, category, country, rate_type, interest_min, interest_max, term_min, term_max, term_unit, active, required_documents, created_at, updated_at)
     values ($1, $2, 'Test Product', $3, $4, null, null, null, null, null, 'MONTHS', true, $5::jsonb, now(), now())`,
    [productId, lenderId, params.category, params.country, JSON.stringify(params.requiredDocuments)]
  );
  return { lenderId, productId };
}
