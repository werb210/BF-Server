import { randomUUID } from "node:crypto";
import { pool, runQuery } from "../db.js";
import { AppError } from "../middleware/errors.js";
import { logError } from "../observability/logger.js";

export interface CreateLenderInput {
  name: string;
  country: string;
  submission_method: string;
  active?: boolean;
  status?: string | null;
  email?: string | null;
  primary_contact_name?: string | null;
  primary_contact_email?: string | null;
  primary_contact_phone?: string | null;
  submission_email?: string | null;
  api_config?: Record<string, unknown> | null;
  submission_config?: Record<string, unknown> | null;
  website?: string | null;
  webpage?: string | null;
  street?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  silo?: string | null;
}

const LENDERS_REPO = "src/repositories/lenders.repo.ts";


export function normalizeSubmissionMethod(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = String(value).trim().toUpperCase();
  if (v === "GOOGLE_SHEETS") v = "GOOGLE_SHEET";
  const allowed = ["EMAIL", "API", "GOOGLE_SHEET", "MANUAL"];
  return allowed.includes(v) ? v : null;
}

export function reconcileSubmissionPayload(input: {
  method: string | null;
  email: string | null;
  apiConfig: Record<string, unknown> | null;
  submissionConfig: Record<string, unknown> | null;
}) {
  const method = normalizeSubmissionMethod(input.method);
  const hasApiConfig = Boolean(input.apiConfig);
  const hasSubmissionConfig = Boolean(input.submissionConfig);

  if (!method) {
    return {
      method,
      email: null,
      apiConfig: null,
      submissionConfig: null,
    };
  }

  if (method === "EMAIL") {
    if (!input.email || input.email.trim().length === 0) {
      return { method: null, email: null, apiConfig: null, submissionConfig: null };
    }
    return {
      method: "EMAIL",
      email: input.email,
      apiConfig: null,
      submissionConfig: null,
    };
  }

  if (method === "API") {
    if (!hasApiConfig) {
      return { method: null, email: null, apiConfig: null, submissionConfig: null };
    }
    return {
      method: "API",
      email: null,
      apiConfig: input.apiConfig,
      submissionConfig: null,
    };
  }

  if (method === "GOOGLE_SHEET") {
    if (!hasSubmissionConfig) {
      return { method: null, email: null, apiConfig: null, submissionConfig: null };
    }
    return {
      method,
      email: null,
      apiConfig: null,
      submissionConfig: input.submissionConfig,
    };
  }

  if (method === "MANUAL") {
    return { method: "MANUAL", email: null, apiConfig: null, submissionConfig: null };
  }

  return { method: null, email: null, apiConfig: null, submissionConfig: null };
}
const LENDERS_TABLE = "lenders";

type ColumnCheckResult = {
  existing: Set<string>;
  missing: string[];
};

async function fetchLenderColumns(): Promise<Set<string>> {
  const result = await runQuery<{ column_name: string }>(
    `select column_name
     from information_schema.columns
     where table_schema = 'public'
       and table_name = $1`,
    [LENDERS_TABLE]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function assertLenderColumnsExist(params: {
  route: string;
  columns: string[];
  required?: string[];
}): Promise<ColumnCheckResult> {
  try {
    const existing = await fetchLenderColumns();
    const missing = params.columns.filter((column) => !existing.has(column));
    const required = params.required ?? [];
    const missingRequired = required.filter((column) => !existing.has(column));
    if (missing.length > 0) {
      for (const column of missing) {
        logError("schema_column_missing", {
          route: params.route,
          repository: LENDERS_REPO,
          column,
          table: LENDERS_TABLE,
        });
      }
    }
    if (missingRequired.length > 0) {
      throw new AppError(
        "db_schema_error",
        `Missing required columns on ${LENDERS_TABLE}: ${missingRequired.join(", ")}`,
        500
      );
    }
    return { existing, missing };
  } catch (err) {
    if (err instanceof AppError) {
      throw err;
    }
    logError("schema_column_check_failed", {
      route: params.route,
      repository: LENDERS_REPO,
      table: LENDERS_TABLE,
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
    { name: "name" },
    { name: "country" },
    { name: "submission_method", fallback: "'email'::text" },
    { name: "active", fallback: "true" },
    { name: "status", fallback: "'ACTIVE'::text" },
    { name: "email", fallback: "null::text" },
    { name: "primary_contact_name", fallback: "null::text" },
    { name: "primary_contact_email", fallback: "null::text" },
    { name: "primary_contact_phone", fallback: "null::text" },
    { name: "website", fallback: "null::text" },
    { name: "webpage", fallback: "null::text" },
    { name: "street", fallback: "null::text" },
    { name: "city", fallback: "null::text" },
    { name: "region", fallback: "null::text" },
    { name: "postal_code", fallback: "null::text" },
    { name: "phone", fallback: "null::text" },
    { name: "primary_contact_phone", fallback: "null::text" },
    { name: "submission_email", fallback: "null::text" },
    { name: "api_config", fallback: "null::jsonb" },
    { name: "submission_config", fallback: "null::jsonb" },
    { name: "silo", fallback: "null::text" },
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

export const LIST_LENDERS_SQL = `
  SELECT
    id,
    name,
    country,
    COALESCE(status, 'ACTIVE') AS status,
    COALESCE(primary_contact_name, '') AS primary_contact_name,
    submission_email,
    website,
    webpage,
    api_config,
    submission_config,
    active,
    created_at
  FROM lenders
  ORDER BY created_at DESC
`;

type QueryExecutor = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export async function listLenders(db: QueryExecutor) {
  try {
    // Try the flexible column-aware version first
    const existing = await fetchLenderColumns();
    if (existing.size === 0) {
      // Table doesn't exist or is empty schema — return safe empty list
      return [];
    }
    const selectColumns = buildSelectColumns(existing);
    const { rows } = await db.query(`
      SELECT
        ${selectColumns}
      FROM lenders
      ORDER BY created_at DESC
    `);
    return rows;
  } catch {
    // Fallback: try simple wildcard query
    try {
      const { rows } = await db.query(`SELECT * FROM lenders ORDER BY id DESC LIMIT 200`);
      return rows;
    } catch {
      return []; // Table doesn't exist yet — return empty, don't crash
    }
  }
}

export async function fetchLenderById(id: string) {
  const check = await assertLenderColumnsExist({
    route: "/api/lenders/:id",
    columns: [
      "id",
      "name",
      "country",
      "status",
      "email",
      "submission_method",
      "submission_email",
      "api_config",
      "submission_config",
      "primary_contact_name",
      "primary_contact_email",
      "primary_contact_phone",
      "website",
      "created_at",
      "updated_at",
      "active",
    ],
    required: ["id", "name", "country"],
  });
  const selectColumns = buildSelectColumns(check.existing);
  const result = await runQuery(
    `
    SELECT
      ${selectColumns}
    FROM lenders
    WHERE id = $1
    LIMIT 1
    `,
    [id]
  );
  const rows = result.rows;
  return rows[0] ?? null;
}

export async function createLender(
  db: QueryExecutor,
  input: CreateLenderInput
) {
  const {
    name,
    country,
    email,
    primary_contact_name,
    primary_contact_email,
    primary_contact_phone,
    submission_email,
    api_config,
    submission_config,
    website,
    webpage,
    street,
    city,
    region,
    postal_code,
    phone,
    silo,
  } = input;
  const existingColumns = await fetchLenderColumns();
  const includeActive = existingColumns.has("active");
  const reconciledSubmission = reconcileSubmissionPayload({
    method: normalizeSubmissionMethod(input.submission_method),
    email: submission_email ?? null,
    apiConfig: api_config ?? null,
    submissionConfig: submission_config ?? null,
  });
  const normalizedStatus =
    typeof input.status === "string"
      ? input.status.trim().toUpperCase()
      : null;
  const statusValue =
    typeof input.active === "boolean"
      ? input.active
        ? "ACTIVE"
        : "INACTIVE"
      : normalizedStatus === "ACTIVE" || normalizedStatus === "INACTIVE"
        ? normalizedStatus
        : "ACTIVE";
  const activeValue = statusValue === "ACTIVE";

  const columns: Array<{ name: string; value: unknown; raw?: boolean }> = [
    { name: "id", value: "gen_random_uuid()", raw: true },
    { name: "name", value: name },
    { name: "country", value: country },
    { name: "website", value: website ?? null },
    { name: "webpage", value: webpage ?? null },
    { name: "street", value: street ?? null },
    { name: "city", value: city ?? null },
    { name: "region", value: region ?? null },
    { name: "postal_code", value: postal_code ?? null },
    { name: "phone", value: phone ?? null },
    { name: "silo", value: silo ?? null },
    { name: "created_at", value: "now()", raw: true },
    { name: "updated_at", value: "now()", raw: true },
    { name: "status", value: statusValue },
  ];

  columns.push({
    name: "email",
    value: email ?? null,
  });
  columns.push({
    name: "primary_contact_name",
    value: primary_contact_name ?? null,
  });
  columns.push({
    name: "primary_contact_email",
    value: primary_contact_email ?? null,
  });
  columns.push({
    name: "primary_contact_phone",
    value: primary_contact_phone ?? null,
  });
  columns.push({
    name: "submission_method",
    value: reconciledSubmission.method,
  });
  columns.push({
    name: "submission_email",
    value: reconciledSubmission.email,
  });
  columns.push({
    name: "api_config",
    value: reconciledSubmission.apiConfig,
  });
  if (existingColumns.has("submission_config")) {
    columns.push({
      name: "submission_config",
      value: reconciledSubmission.submissionConfig,
    });
  }
  if (includeActive) {
    columns.push({ name: "active", value: activeValue });
  }

  const filteredColumns = columns.filter((entry) => existingColumns.has(entry.name) || entry.raw);

  const buildInsert = (entries: Array<{ name: string; value: unknown; raw?: boolean }>) => {
    const values: unknown[] = [];
    const placeholders = entries.map((entry) => {
      if (entry.raw) {
        return String(entry.value);
      }
      values.push(entry.value);
      if (entry.name === "status") {
        return `$${values.length}::lender_status`;
      }
      return `$${values.length}`;
    });
    return { values, placeholders };
  };

  try {
    const columnNames = filteredColumns.map((entry) => entry.name);
    const { values, placeholders } = buildInsert(filteredColumns);
    const { rows } = await db.query(
      `
      INSERT INTO lenders (
        ${columnNames.join(",\n        ")}
      )
      VALUES (
        ${placeholders.join(",\n        ")}
      )
      RETURNING ${buildSelectColumns(existingColumns)}
    `,
      values
    );
    return rows[0];
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = (err as { message?: string }).message ?? "";
    if (code === "42883" || message.includes("gen_random_uuid")) {
      const adjustedColumns = filteredColumns.map((entry) =>
        entry.raw
          ? { name: entry.name, value: randomUUID() }
          : entry
      );
      const columnNames = adjustedColumns.map((entry) => entry.name);
      const { values, placeholders } = buildInsert(adjustedColumns);
      const { rows } = await db.query(
        `
        INSERT INTO lenders (
          ${columnNames.join(",\n          ")}
        )
        VALUES (
          ${placeholders.join(",\n          ")}
        )
        RETURNING ${buildSelectColumns(existingColumns)}
      `,
        values
      );
      return rows[0];
    }
    throw err;
  }
}

export async function updateLender(
  db: QueryExecutor,
  params: {
    id: string;
    name?: string | null;
    status?: string | null;
    country?: string | null;
    email?: string | null;
    submission_method?: string | null;
    primary_contact_name?: string | null;
    primary_contact_email?: string | null;
    primary_contact_phone?: string | null;
    submission_email?: string | null;
    api_config?: Record<string, unknown> | null;
    submission_config?: Record<string, unknown> | null;
    website?: string | null;
    webpage?: string | null;
    active?: boolean;
    silo?: string | null;
  }
) {
  const existingColumns = await fetchLenderColumns();
  const shouldReconcileSubmissionFields =
    params.submission_method !== undefined ||
    params.submission_email !== undefined ||
    params.api_config !== undefined ||
    params.submission_config !== undefined;
  const existingLender = shouldReconcileSubmissionFields
    ? await fetchLenderById(params.id)
    : null;
  const updates: Array<{ name: string; value: unknown }> = [];
  const normalizedStatus =
    typeof params.status === "string"
      ? params.status.trim().toUpperCase()
      : null;
  const resolvedStatus =
    typeof params.active === "boolean"
      ? params.active
        ? "ACTIVE"
        : "INACTIVE"
      : normalizedStatus === "ACTIVE" || normalizedStatus === "INACTIVE"
        ? normalizedStatus
        : null;
  const resolvedActive =
    typeof params.active === "boolean"
      ? params.active
      : resolvedStatus
        ? resolvedStatus === "ACTIVE"
        : undefined;

  if (params.name !== undefined && existingColumns.has("name")) {
    updates.push({ name: "name", value: params.name });
  }
  if (resolvedStatus !== null && existingColumns.has("status")) {
    updates.push({ name: "status", value: resolvedStatus });
  }
  if (params.country !== undefined && existingColumns.has("country")) {
    updates.push({ name: "country", value: params.country });
  }
  if (params.email !== undefined && existingColumns.has("email")) {
    updates.push({ name: "email", value: params.email });
  }
  const normalizedUpdateSubmissionMethod =
    params.submission_method !== undefined
      ? normalizeSubmissionMethod(params.submission_method)
      : undefined;
  if (params.primary_contact_name !== undefined) {
    updates.push({ name: "primary_contact_name", value: params.primary_contact_name });
  }
  if (params.primary_contact_email !== undefined) {
    updates.push({ name: "primary_contact_email", value: params.primary_contact_email });
  }
  if (params.primary_contact_phone !== undefined) {
    updates.push({ name: "primary_contact_phone", value: params.primary_contact_phone });
  }
  if (shouldReconcileSubmissionFields) {
    const reconciledSubmission = reconcileSubmissionPayload({
      method:
        normalizedUpdateSubmissionMethod
        ?? normalizeSubmissionMethod(existingLender?.submission_method ?? null),
      email:
        params.submission_email !== undefined
          ? params.submission_email
          : existingLender?.submission_email ?? null,
      apiConfig:
        params.api_config !== undefined
          ? params.api_config
          : existingLender?.api_config ?? null,
      submissionConfig:
        params.submission_config !== undefined
          ? params.submission_config
          : existingLender?.submission_config ?? null,
    });

    if (existingColumns.has("submission_method")) {
      updates.push({ name: "submission_method", value: reconciledSubmission.method });
    }
    if (existingColumns.has("submission_email")) {
      updates.push({ name: "submission_email", value: reconciledSubmission.email });
    }
    if (existingColumns.has("api_config")) {
      updates.push({ name: "api_config", value: reconciledSubmission.apiConfig });
    }
    if (existingColumns.has("submission_config")) {
      updates.push({ name: "submission_config", value: reconciledSubmission.submissionConfig });
    }
  }
  if (params.website !== undefined && existingColumns.has("website")) {
    updates.push({ name: "website", value: params.website });
  }
  if (params.webpage !== undefined && existingColumns.has("webpage")) {
    updates.push({ name: "webpage", value: params.webpage });
  }
  if (resolvedActive !== undefined && existingColumns.has("active")) {
    updates.push({ name: "active", value: resolvedActive });
  }
  if (params.silo !== undefined && existingColumns.has("silo")) {
    updates.push({ name: "silo", value: params.silo });
  }

  if (updates.length === 0) {
    return fetchLenderById(params.id);
  }

  const setClauses = updates.map((entry, index) =>
    entry.name === "status"
      ? `${entry.name} = $${index + 1}::lender_status`
      : `${entry.name} = $${index + 1}`
  );
  const values = updates.map((entry) => entry.value);
  values.push(params.id);

  const { rows } = await db.query(
    `
    UPDATE lenders
    SET ${setClauses.join(", ")}
    WHERE id = $${values.length}
    RETURNING ${buildSelectColumns(existingColumns)}
    `,
    values
  );
  return rows[0] ?? null;
}
