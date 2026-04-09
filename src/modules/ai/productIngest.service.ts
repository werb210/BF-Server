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
    await embedAndStore(db, toProductKnowledge(product), "product", product.id);
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

  await embedAndStore(db, toProductKnowledge(product), "product", product.id);
}
