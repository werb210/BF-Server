import { embedAndStore } from "./knowledge.service.js";

type Queryable = {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

type LenderProductRow = {
  id: string;
  name: string | null;
  category: string | null;
  interest_min: string | number | null;
  interest_max: string | number | null;
  term_min: number | null;
  term_max: number | null;
  country: string | null;
};

function toProductKnowledge(row: LenderProductRow): string {
  return [
    `Product: ${row.name ?? "Unnamed Product"}`,
    `Type: ${row.category ?? "N/A"}`,
    `Min Rate: ${row.interest_min ?? "N/A"}`,
    `Max Rate: ${row.interest_max ?? "N/A"}`,
    `Term Min: ${row.term_min ?? "N/A"}`,
    `Term Max: ${row.term_max ?? "N/A"}`,
    `Country: ${row.country ?? "N/A"}`,
  ].join("\n");
}

export async function ingestAllProducts(db: Queryable): Promise<void> {
  const products = await db.query<LenderProductRow>(
    `select id, name, category, interest_min, interest_max, term_min, term_max, country
     from lender_products`
  );

  for (const product of products.rows) {
    await embedAndStore(
      db,
      toProductKnowledge(product),
      "product",
      product.id,
      product.name ?? `Product ${product.id}`,
    );
  }
}

export async function ingestProductById(db: Queryable, productId: string): Promise<void> {
  const result = await db.query<LenderProductRow>(
    `select id, name, category, interest_min, interest_max, term_min, term_max, country
     from lender_products
     where id = $1
     limit 1`,
    [productId]
  );

  const product = result.rows[0];
  if (!product) {
    return;
  }

  await embedAndStore(
      db,
      toProductKnowledge(product),
      "product",
      product.id,
      product.name ?? `Product ${product.id}`,
    );
}

// BF_SERVER_PRODUCT_KNOWLEDGE_SYNC_v1 - reconcile Maya knowledge with lender_products.
// Ingests any product not yet in ai_knowledge (covers manual/portal/raw-SQL inserts) and
// prunes knowledge rows for products that no longer exist. Safe to run repeatedly.
export async function reconcileProductKnowledge(
  db: Queryable,
): Promise<{ ingested: number; pruned: number }> {
  const missing = await db.query<{ id: string }>(
    `select p.id
       from lender_products p
      where not exists (
        select 1 from ai_knowledge k
         where k.source_type like 'product%' and k.source_id = p.id
      )`
  );

  let ingested = 0;
  for (const row of missing.rows) {
    try {
      await ingestProductById(db, row.id);
      ingested += 1;
    } catch {
      // embedAndStore throws if OPENAI_API_KEY is unset or embedding fails; skip and retry next tick.
    }
  }

  const prunedRes = await db.query<{ id: string }>(
    `delete from ai_knowledge
      where source_type like 'product%'
        and source_id is not null
        and source_id not in (select id from lender_products)
    returning id`
  );

  return { ingested, pruned: prunedRes.rows.length };
}
