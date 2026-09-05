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

// BF_SERVER_MAYA_PRODUCT_ENVELOPE_v1 - Maya answered product amounts/rates
// inconsistently because ingestAllProducts wrote ONE knowledge row per
// lender_product (~100 conflicting entries, and amount was never ingested).
// This writes ONE consolidated envelope per category (min/max amount, rate and
// term across all lenders in that category) so Maya has a single authoritative
// fact to answer "how much / what rate" with, consistently.
const CATEGORY_DISPLAY: Record<string, string> = {
  LOC: "Line of Credit", TERM: "Term Loan", EQUIPMENT: "Equipment Financing",
  FACTORING: "Invoice Factoring", MCA: "Merchant Cash Advance", PO: "Purchase Order Financing",
  ABL: "Asset-Based Lending", SBA: "SBA Loan", MEDIA: "Media & Production Financing",
  STARTUP: "Start-up Financing",
};
function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toString().replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toString().replace(/\.0$/, "")}K`;
  return `$${n}`;
}
export async function ingestProductCategoryEnvelopes(db: Queryable): Promise<number> {
  const rows = await db.query<{
    category: string; amt_min: number | null; amt_max: number | null;
    rate_min: string | number | null; rate_max: string | number | null;
    term_min: number | null; term_max: number | null; countries: string | null;
  }>(
    `select category,
            min(amount_min)                       as amt_min,
            max(amount_max)                       as amt_max,
            min(nullif(interest_min,'')::numeric) as rate_min,
            max(nullif(interest_max,'')::numeric) as rate_max,
            min(term_min)                         as term_min,
            max(term_max)                         as term_max,
            string_agg(distinct country, ', ')    as countries
       from lender_products
      where category is not null
      group by category`
  );
  let count = 0;
  for (const r of rows.rows) {
    const display = CATEGORY_DISPLAY[r.category] ?? r.category;
    const rate = r.rate_min != null && r.rate_max != null
      ? `${Number(r.rate_min)}% to ${Number(r.rate_max)}% (illustrative; varies by lender)`
      : "Varies by lender";
    const term = r.term_min != null && r.term_max != null
      ? `${r.term_min} to ${r.term_max} months` : "Varies by lender";
    const content = [
      `Product category: ${display} (${r.category})`,
      `Funding amount range: ${money(r.amt_min)} to ${money(r.amt_max)}`,
      `Interest / rate range: ${rate}`,
      `Term range: ${term}`,
      `Available in: ${r.countries ?? "N/A"}`,
      `Boreal is a lending marketplace, not the lender; exact amount, rate and term depend on the lender and the business. Never quote a single guaranteed figure.`,
    ].join("\n");
    await embedAndStore(db, content, "product:category", r.category, `${display} (category envelope)`);
    count += 1;
  }
  return count;
}
