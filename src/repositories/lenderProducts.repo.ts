import { toStringSet } from "../utils/collectionSafe";
import { randomUUID } from "crypto";
import { pool, runQuery } from "../db";
import { type PoolClient } from "pg";
import {
  type LenderProductRecord,
  type RequiredDocuments,
} from "../db/schema/lenderProducts";
import { AppError } from "../middleware/errors";
import { logError } from "../observability/logger";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

const LENDER_PRODUCTS_REPO = "src/repositories/lenderProducts.repo.ts";
const LENDER_PRODUCTS_TABLE = "lender_products";

async function assertLenderProductColumnsExist(params: {
  route: string;
  columns: string[];
  client: Queryable;
  allowMissing?: boolean;
}): Promise<Set<string>> {
  try {
    const result = await params.client.runQuery<{ column_name: string }>(
      `select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = $1`,
      [LENDER_PRODUCTS_TABLE]
    );
    const existing = toStringSet(result.rows.map((row) => row.column_name));
    const missing = params.columns.filter((column) => !existing.has(column));
    if (missing.length === 0) {
      return existing;
    }
    for (const column of missing) {
      logError("schema_column_missing", {
        route: params.route,
        repository: LENDER_PRODUCTS_REPO,
        column,
        table: LENDER_PRODUCTS_TABLE,
      });
    }
    if (!params.allowMissing) {
      throw new AppError(
        "db_schema_error",
        `Missing columns on ${LENDER_PRODUCTS_TABLE}: ${missing.join(", ")}`,
        500
      );
    }
    return existing;
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    logError("schema_column_check_failed", {
      route: params.route,
      repository: LENDER_PRODUCTS_REPO,
      table: LENDER_PRODUCTS_TABLE,
      stack: err instanceof Error ? err.stack : undefined,
    });
    const error = err instanceof Error ? err : new Error("Unknown schema error.");
    const appError = new AppError("db_error", error.message, 500);
    if (error.stack) {
      appError.stack = error.stack;
    }
    throw appError;
  }
}

function buildSelectColumns(existing: Set<string>): string {
  const columns: Array<{ name: string; fallback?: string }> = [
    { name: "id" },
    { name: "lender_id" },
    { name: "name", fallback: "'Unnamed Product'::text" },
    { name: "category", fallback: "'LOC'::text" },
    { name: "country", fallback: "'BOTH'::text" },
    { name: "active", fallback: "true" },
    { name: "rate_type", fallback: "null::text" },
    { name: "interest_min", fallback: "null::text" },
    { name: "interest_max", fallback: "null::text" },
    { name: "term_min", fallback: "null::integer" },
    { name: "term_max", fallback: "null::integer" },
    { name: "term_unit", fallback: "'MONTHS'::text" },
    { name: "required_documents", fallback: "'[]'::jsonb" },
    { name: "created_at", fallback: "now()" },
    { name: "updated_at", fallback: "now()" },
  ];

  return columns
    .map((column) => {
      if (existing.has(column.name)) {
        return column.name;
      }
      const fallback = column.fallback ?? "null";
      return `${fallback} as ${column.name}`;
    })
    .join(", ");
}

export async function createLenderProduct(params: {
  lenderId: string;
  name: string;
  active: boolean;
  category: string;
  requiredDocuments: RequiredDocuments;
  country?: string | null;
  rateType?: string | null;
  interestMin?: number | string | null;
  interestMax?: number | string | null;
  termMin?: number | null;
  termMax?: number | null;
  client?: Queryable;
}): Promise<LenderProductRecord> {
  const runner = params.client ?? pool;
  const existing = await assertLenderProductColumnsExist({
    route: "/api/lender-products",
    columns: [
      "id",
      "lender_id",
      "name",
      "active",
      "country",
      "rate_type",
      "interest_min",
      "interest_max",
      "term_min",
      "term_max",
      "term_unit",
      "category",
      "required_documents",
      "created_at",
      "updated_at",
    ],
    client: runner,
  });
  const selectColumns = buildSelectColumns(existing);
  const columns = [
    { name: "id", value: randomUUID() },
    { name: "lender_id", value: params.lenderId },
    { name: "name", value: params.name },
    { name: "category", value: params.category },
    { name: "active", value: params.active },
    { name: "required_documents", value: JSON.stringify(params.requiredDocuments) },
    { name: "country", value: params.country ?? null },
    { name: "rate_type", value: params.rateType ?? null },
    { name: "interest_min", value: params.interestMin ?? null },
    { name: "interest_max", value: params.interestMax ?? null },
    { name: "term_min", value: params.termMin ?? null },
    { name: "term_max", value: params.termMax ?? null },
    { name: "term_unit", value: "MONTHS" },
  ].filter((entry) => existing.has(entry.name));

  const columnNames = columns.map((entry) => entry.name);
  const placeholders = columnNames.map((_, index) => `$${index + 1}`);
  const values = columns.map((entry) => entry.value);

  const res = await runner.query<LenderProductRecord>(
    `insert into lender_products
     (${columnNames.join(", ")}, created_at, updated_at)
     values (${placeholders.join(", ")}, now(), now())
     returning ${selectColumns}`,
    values
  );
  const rows = res.rows;
  const created = rows[0];
  if (!created) {
    throw new AppError("db_error", "Failed to create lender product.", 500);
  }
  return created;
}

export const LIST_LENDER_PRODUCTS_SQL = `select id,
        lender_id,
        name,
        category,
        country,
        active,
        rate_type,
        interest_min,
        interest_max,
        term_min,
        term_max,
        term_unit,
        required_documents,
        created_at,
        updated_at
 from lender_products
 order by created_at desc`;

export async function listLenderProducts(
  client?: Queryable
): Promise<LenderProductRecord[]> {
  const runner = client ?? pool;
  try {
    const existing = await assertLenderProductColumnsExist({
      route: "/api/lender-products",
      columns: [
        "id",
        "lender_id",
        "name",
        "active",
        "category",
        "country",
        "rate_type",
        "interest_min",
        "interest_max",
        "term_min",
        "term_max",
        "term_unit",
        "required_documents",
        "created_at",
        "updated_at",
      ],
      client: runner,
      allowMissing: true,
    });
    const selectColumns = buildSelectColumns(existing);
    const res = await runner.query<LenderProductRecord>(
      `select ${selectColumns}
       from lender_products
       order by created_at desc`
    );
    return res.rows;
  } catch (err) {
    logError("lender_products_query_failed", {
      sql: LIST_LENDER_PRODUCTS_SQL,
      params: [],
      stack: err instanceof Error ? err.stack : undefined,
    });
    const error = err instanceof Error ? err : new Error("Unknown database error.");
    const appError = new AppError("db_error", error.message, 500);
    if (error.stack) {
      appError.stack = error.stack;
    }
    throw appError;
  }
}

export async function listLenderProductsByLenderId(
  lenderId: string,
  client?: Queryable
): Promise<LenderProductRecord[]> {
  const runner = client ?? pool;
  const existing = await assertLenderProductColumnsExist({
    route: "/api/lenders/:id/products",
    columns: [
      "id",
      "lender_id",
      "name",
      "active",
      "category",
      "country",
      "rate_type",
      "interest_min",
      "interest_max",
      "term_min",
      "term_max",
      "term_unit",
      "required_documents",
      "created_at",
      "updated_at",
    ],
    client: runner,
    allowMissing: true,
  });
  const selectColumns = buildSelectColumns(existing);
  const res = await runner.query<LenderProductRecord>(
    `select ${selectColumns}
     from lender_products
     where lender_id = $1
     order by created_at desc`,
    [lenderId]
  );
  return res.rows;
}

export async function fetchLenderProductById(
  id: string,
  client?: Queryable
): Promise<LenderProductRecord | null> {
  const runner = client ?? pool;
  const existing = await assertLenderProductColumnsExist({
    route: "/api/lender-products/:id",
    columns: [
      "id",
      "lender_id",
      "name",
      "active",
      "category",
      "country",
      "rate_type",
      "interest_min",
      "interest_max",
      "term_min",
      "term_max",
      "term_unit",
      "required_documents",
      "created_at",
      "updated_at",
    ],
    client: runner,
  });
  const selectColumns = buildSelectColumns(existing);
  const res = await runner.query<LenderProductRecord>(
    `select ${selectColumns}
     from lender_products
     where id = $1
     limit 1`,
    [id]
  );
  return res.rows[0] ?? null;
}

export async function updateLenderProduct(params: {
  id: string;
  name: string;
  requiredDocuments: RequiredDocuments;
  active?: boolean;
  category?: string | null;
  country?: string | null;
  rateType?: string | null;
  interestMin?: number | string | null;
  interestMax?: number | string | null;
  termMin?: number | null;
  termMax?: number | null;
  client?: Queryable;
}): Promise<LenderProductRecord | null> {
  const runner = params.client ?? pool;
  const existing = await assertLenderProductColumnsExist({
    route: "/api/lender-products/:id",
    columns: [
      "id",
      "lender_id",
      "name",
      "active",
      "category",
      "country",
      "rate_type",
      "interest_min",
      "interest_max",
      "term_min",
      "term_max",
      "term_unit",
      "required_documents",
      "created_at",
      "updated_at",
    ],
    client: runner,
  });
  const updates: Array<{ name: string; value: unknown; cast?: string }> = [
    { name: "name", value: params.name },
    {
      name: "required_documents",
      value: JSON.stringify(params.requiredDocuments),
      cast: "::jsonb",
    },
  ];
  if (existing.has("active") && params.active !== undefined) {
    updates.push({ name: "active", value: params.active });
  }
  if (existing.has("category") && params.category !== undefined) {
    updates.push({ name: "category", value: params.category });
  }
  if (existing.has("country") && params.country !== undefined) {
    updates.push({ name: "country", value: params.country });
  }
  if (existing.has("rate_type") && params.rateType !== undefined) {
    updates.push({ name: "rate_type", value: params.rateType });
  }
  if (existing.has("interest_min") && params.interestMin !== undefined) {
    updates.push({ name: "interest_min", value: params.interestMin });
  }
  if (existing.has("interest_max") && params.interestMax !== undefined) {
    updates.push({ name: "interest_max", value: params.interestMax });
  }
  if (existing.has("term_min") && params.termMin !== undefined) {
    updates.push({ name: "term_min", value: params.termMin ?? null });
  }
  if (existing.has("term_max") && params.termMax !== undefined) {
    updates.push({ name: "term_max", value: params.termMax ?? null });
  }

  const setClauses = updates.map(
    (entry, index) =>
      `${entry.name} = $${index + 1}${entry.cast ?? ""}`
  );
  const values = updates.map((entry) => entry.value);
  values.push(params.id);
  const selectColumns = buildSelectColumns(existing);

  const res = await runner.query<LenderProductRecord>(
    `update lender_products
     set ${setClauses.join(", ")},
         updated_at = now()
     where id = $${values.length}
     returning ${selectColumns}`,
    values
  );
  return res.rows[0] ?? null;
}
