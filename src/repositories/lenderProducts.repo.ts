import { toStringSet } from "../utils/collectionSafe.js";
import { randomUUID } from "node:crypto";
import { pool, runQuery } from "../db.js";
import { type PoolClient } from "pg";
import {
  type LenderProductRecord,
  type RequiredDocuments,
} from "../db/schema/lenderProducts.js";
import { AppError } from "../middleware/errors.js";
import { logError } from "../observability/logger.js";

type Queryable = Pick<PoolClient, "query">;

// When a lender product is created or edited, the cached lender matches on
// every still-in-progress application become out of date. Flag them stale so
// the Lenders tab shows the Recalculate prompt. Applications already sent to a
// lender (Off to Lender and beyond) are left untouched. Fire-and-forget.
async function markPreLenderMatchesStale(): Promise<void> {
  try {
    await runQuery(
      `update applications set lender_matches_stale = true
         where pipeline_state in ('Received','In Review','Documents Required','Additional Steps Required')
           and coalesce(lender_matches_stale, false) = false`
    );
  } catch (err) {
    logError('lender_product_mark_matches_stale_failed', { error: err instanceof Error ? err.message : 'unknown_error' });
  }
}

const LENDER_PRODUCTS_REPO = "src/repositories/lenderProducts.repo.ts";
const LENDER_PRODUCTS_TABLE = "lender_products";

export function normalizeRateType(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = String(value).trim().toUpperCase();
  if (upper === "FIXED" || upper === "VARIABLE") return upper;
  return null;
}

async function assertLenderProductColumnsExist(params: {
  route: string;
  columns: string[];
  client: Queryable;
  allowMissing?: boolean;
}): Promise<Set<string>> {
  try {
    const result = await params.client.query<{ column_name: string }>(
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

function buildSelectColumns(existing: Set<string>, alias?: string): string {
  // BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — `alias` is the SQL table
  // alias to prefix existing column names with (e.g. "lp"). Fallback
  // expressions are emitted verbatim — they MUST NOT receive the prefix
  // because PG would parse `lp.null::text` as `lp."null"::text` and error
  // "column lp.null does not exist". This was the production lender-products
  // 500 ("column lp.null does not exist") introduced by the v626 left-join
  // wrapper that blindly mapped each split element through `lp.${c.trim()}`.
  const prefix = alias && alias.trim() ? `${alias.trim()}.` : "";
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
    { name: "commission", fallback: "null::numeric" }, // BF_LP_COMMISSION_CREDIT_v36
    { name: "min_credit_score", fallback: "null::integer" },
    { name: "required_documents", fallback: "'[]'::jsonb" },
    { name: "created_at", fallback: "now()" },
    { name: "updated_at", fallback: "now()" },
    { name: "amount_min", fallback: "null::bigint" },
    { name: "amount_max", fallback: "null::bigint" },
    { name: "signnow_template_id", fallback: "null::text" },  // BF_LP_REPO_FIELDS_v32
    { name: "eligibility_notes", fallback: "null::text" },    // BF_LP_REPO_FIELDS_v32
    // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
    { name: "rate_kind", fallback: "null::text" },
    { name: "rate_min_num", fallback: "null::numeric" },
    { name: "rate_max_num", fallback: "null::numeric" },
    { name: "category_label", fallback: "null::text" },
    { name: "documents_required", fallback: "null::text" },
    { name: "silo", fallback: "null::text" },
  ];

  return columns
    .map((column) => {
      if (existing.has(column.name)) {
        return `${prefix}${column.name}`;
      }
      const fallback = column.fallback ?? "null";
      // Fallback expression is a complete SQL fragment ("null::text as foo")
      // — never prefixed; prefixing would produce "lp.null::text as foo"
      // which PG rejects.
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
  amountMin?: number | null;
  amountMax?: number | null;
  // BF_LP_COMMISSION_CREDIT_v36 — Block 36
  commission?: number | null;
  minCreditScore?: number | null;
  termUnit?: string | null;            // BF_LP_REPO_FIELDS_v32
  signnowTemplateId?: string | null;   // BF_LP_REPO_FIELDS_v32
  eligibilityNotes?: string | null;    // BF_LP_REPO_FIELDS_v32
  // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1 — rate kind plumbing
  rateKind?: string | null;
  rateMinNum?: number | null;
  rateMaxNum?: number | null;
  categoryLabel?: string | null;
  documentsRequired?: string | null;
  silo?: string | null;
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
      "status",
      "country",
      "rate_type",
      "interest_min",
      "interest_max",
      "term_min",
      "term_max",
      "amount_min",
      "amount_max",
      "silo",
      "term_unit",
      "commission",
      "min_credit_score",
      "category",
      "type",
      "required_documents",
      "signnow_template_id",  // BF_LP_REPO_FIELDS_v32
      "eligibility_notes",    // BF_LP_REPO_FIELDS_v32
      // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
      "rate_kind",
      "rate_min_num",
      "rate_max_num",
      "category_label",
      "documents_required",
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
    { name: "type", value: params.category },
    { name: "active", value: params.active },
    { name: "status", value: "active" },
    { name: "required_documents", value: JSON.stringify(params.requiredDocuments) },
    { name: "country", value: params.country ?? null },
    { name: "rate_type", value: normalizeRateType(params.rateType) },
    { name: "interest_min", value: params.interestMin ?? null },
    { name: "interest_max", value: params.interestMax ?? null },
    { name: "term_min", value: params.termMin ?? null },
    { name: "term_max", value: params.termMax ?? null },
    { name: "amount_min", value: params.amountMin ?? null },
    { name: "amount_max", value: params.amountMax ?? null },
    { name: "term_unit", value: (params.termUnit ?? "MONTHS").toString().toUpperCase() },
    // BF_LP_COMMISSION_CREDIT_v36
    { name: "commission", value: params.commission ?? null },
    { name: "min_credit_score", value: params.minCreditScore ?? null },
    { name: "signnow_template_id", value: params.signnowTemplateId ?? null },  // BF_LP_REPO_FIELDS_v32
    { name: "eligibility_notes", value: params.eligibilityNotes ?? null },     // BF_LP_REPO_FIELDS_v32
    // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
    { name: "rate_kind", value: params.rateKind ?? null },
    { name: "rate_min_num", value: params.rateMinNum ?? null },
    { name: "rate_max_num", value: params.rateMaxNum ?? null },
    { name: "category_label", value: params.categoryLabel ?? null },
    { name: "documents_required", value: params.documentsRequired ?? null },
    { name: "silo", value: params.silo ?? null },
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
  void markPreLenderMatchesStale();
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
        amount_min,
        amount_max,
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
        "commission",
        "min_credit_score",
        "required_documents",
        "created_at",
        "updated_at",
      ],
      client: runner,
      allowMissing: true,
    });
    // BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — pass "lp" alias to
    // buildSelectColumns so existing columns are prefixed correctly while
    // fallback expressions remain untouched.
    const selectColumns = buildSelectColumns(existing, "lp");
    const res = await runner.query<LenderProductRecord & { lender_name?: string | null }>(
      `select ${selectColumns},
              l.name AS lender_name
       from lender_products lp
       left join lenders l on l.id = lp.lender_id
       order by lp.created_at desc`
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
      "amount_min",
      "amount_max",
      "silo",
      "term_unit",
      "commission",
      "min_credit_score",
      "required_documents",
      "created_at",
      "updated_at",
    ],
    client: runner,
    allowMissing: true,
  });
  // BF_SERVER_BLOCK_v649_SHOWSTOPPER_PATCHES_v1 — same alias-aware build.
  const selectColumns = buildSelectColumns(existing, "lp");
  const res = await runner.query<LenderProductRecord & { lender_name?: string | null }>(
    `select ${selectColumns},
            l.name AS lender_name
     from lender_products lp
     left join lenders l on l.id = lp.lender_id
     where lp.lender_id = $1
     order by lp.created_at desc`,
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
      "amount_min",
      "amount_max",
      "silo",
      "term_unit",
      "required_documents",
      "signnow_template_id",  // BF_LP_REPO_FIELDS_v32
      "eligibility_notes",    // BF_LP_REPO_FIELDS_v32
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
  lenderId?: string | null;
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
  amountMin?: number | null;
  amountMax?: number | null;
  // BF_LP_COMMISSION_CREDIT_v36
  commission?: number | null;
  minCreditScore?: number | null;
  termUnit?: string | null;            // BF_LP_REPO_FIELDS_v32
  signnowTemplateId?: string | null;   // BF_LP_REPO_FIELDS_v32
  eligibilityNotes?: string | null;    // BF_LP_REPO_FIELDS_v32
  // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
  rateKind?: string | null;
  rateMinNum?: number | null;
  rateMaxNum?: number | null;
  categoryLabel?: string | null;
  documentsRequired?: string | null;
  silo?: string | null;
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
      "amount_min",
      "amount_max",
      "silo",
      "term_unit",
      "required_documents",
      // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
      "rate_kind",
      "rate_min_num",
      "rate_max_num",
      "category_label",
      "documents_required",
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
  // BF_SERVER_BLOCK_v692_LENDER_PRODUCT_REASSIGN_v1 — allow moving a product to a
  // different lender. The PUT route previously dropped lenderId so reassignment no-opped.
  if (existing.has("lender_id") && typeof params.lenderId === "string" && params.lenderId.trim()) {
    updates.push({ name: "lender_id", value: params.lenderId.trim(), cast: "::uuid" });
  }
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
    updates.push({ name: "rate_type", value: normalizeRateType(params.rateType) });
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
  // BF_LP_COMMISSION_CREDIT_v36 — also persist commission + minimum credit score on UPDATE.
  if (existing.has("commission") && params.commission !== undefined) {
    updates.push({ name: "commission", value: params.commission ?? null });
  }
  if (existing.has("min_credit_score") && params.minCreditScore !== undefined) {
    updates.push({ name: "min_credit_score", value: params.minCreditScore ?? null });
  }
  // BF_LP_REPO_FIELDS_v32 — also persist amount, term_unit, signnow, eligibility on UPDATE.
  if (existing.has("amount_min") && params.amountMin !== undefined) {
    updates.push({ name: "amount_min", value: params.amountMin ?? null });
  }
  if (existing.has("amount_max") && params.amountMax !== undefined) {
    updates.push({ name: "amount_max", value: params.amountMax ?? null });
  }
  if (existing.has("term_unit") && params.termUnit !== undefined && params.termUnit !== null) {
    updates.push({ name: "term_unit", value: String(params.termUnit).toUpperCase() });
  }
  if (existing.has("signnow_template_id") && params.signnowTemplateId !== undefined) {
    updates.push({ name: "signnow_template_id", value: params.signnowTemplateId ?? null });
  }
  if (existing.has("eligibility_notes") && params.eligibilityNotes !== undefined) {
    updates.push({ name: "eligibility_notes", value: params.eligibilityNotes ?? null });
  }
  // BF_SERVER_BLOCK_v647_LENDER_PRODUCTS_SEED_v1
  if (existing.has("rate_kind") && params.rateKind !== undefined) {
    updates.push({ name: "rate_kind", value: params.rateKind ?? null });
  }
  if (existing.has("rate_min_num") && params.rateMinNum !== undefined) {
    updates.push({ name: "rate_min_num", value: params.rateMinNum ?? null });
  }
  if (existing.has("rate_max_num") && params.rateMaxNum !== undefined) {
    updates.push({ name: "rate_max_num", value: params.rateMaxNum ?? null });
  }
  if (existing.has("category_label") && params.categoryLabel !== undefined) {
    updates.push({ name: "category_label", value: params.categoryLabel ?? null });
  }
  if (existing.has("documents_required") && params.documentsRequired !== undefined) {
    updates.push({ name: "documents_required", value: params.documentsRequired ?? null });
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
  void markPreLenderMatchesStale();
  return res.rows[0] ?? null;
}
