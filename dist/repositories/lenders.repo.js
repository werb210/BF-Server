"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIST_LENDERS_SQL = void 0;
exports.listLenders = listLenders;
exports.fetchLenderById = fetchLenderById;
exports.createLender = createLender;
exports.updateLender = updateLender;
const crypto_1 = require("crypto");
const db_1 = require("../db");
const errors_1 = require("../middleware/errors");
const logger_1 = require("../observability/logger");
const LENDERS_REPO = "src/repositories/lenders.repo.ts";
const LENDERS_TABLE = "lenders";
async function fetchLenderColumns() {
    const result = await db_1.pool.runQuery(`select column_name
     from information_schema.columns
     where table_schema = 'public'
       and table_name = $1`, [LENDERS_TABLE]);
    return new Set(result.rows.map((row) => row.column_name));
}
async function assertLenderColumnsExist(params) {
    try {
        const existing = await fetchLenderColumns();
        const missing = params.columns.filter((column) => !existing.has(column));
        const required = params.required ?? [];
        const missingRequired = required.filter((column) => !existing.has(column));
        if (missing.length > 0) {
            for (const column of missing) {
                (0, logger_1.logError)("schema_column_missing", {
                    route: params.route,
                    repository: LENDERS_REPO,
                    column,
                    table: LENDERS_TABLE,
                });
            }
        }
        if (missingRequired.length > 0) {
            throw new errors_1.AppError("db_schema_error", `Missing required columns on ${LENDERS_TABLE}: ${missingRequired.join(", ")}`, 500);
        }
        return { existing, missing };
    }
    catch (err) {
        if (err instanceof errors_1.AppError) {
            throw err;
        }
        (0, logger_1.logError)("schema_column_check_failed", {
            route: params.route,
            repository: LENDERS_REPO,
            table: LENDERS_TABLE,
            stack: err instanceof Error ? err.stack : undefined,
        });
        const error = err instanceof Error ? err : new Error("Unknown schema error.");
        const appError = new errors_1.AppError("db_error", error.message, 500);
        if (error.stack) {
            appError.stack = error.stack;
        }
        throw appError;
    }
}
function buildSelectColumns(existing) {
    const columns = [
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
        { name: "submission_email", fallback: "null::text" },
        { name: "api_config", fallback: "null::jsonb" },
        { name: "submission_config", fallback: "null::jsonb" },
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
exports.LIST_LENDERS_SQL = `
  SELECT
    id,
    name,
    country,
    COALESCE(status, 'ACTIVE') AS status,
    COALESCE(primary_contact_name, '') AS primary_contact_name,
    submission_email,
    website,
    api_config,
    submission_config,
    active,
    created_at
  FROM lenders
  ORDER BY created_at DESC
`;
async function listLenders(db) {
    const existing = await fetchLenderColumns();
    const selectColumns = buildSelectColumns(existing);
    const { rows } = await db.query(`
    SELECT
      ${selectColumns}
    FROM lenders
    ORDER BY created_at DESC
  `);
    return rows;
}
async function fetchLenderById(id) {
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
    const result = await db_1.pool.runQuery(`
    SELECT
      ${selectColumns}
    FROM lenders
    WHERE id = $1
    LIMIT 1
    `, [id]);
    const rows = result.rows;
    return rows[0] ?? null;
}
async function createLender(db, input) {
    const { name, country, email, primary_contact_name, primary_contact_email, primary_contact_phone, submission_email, api_config, submission_config, website, } = input;
    const existingColumns = await fetchLenderColumns();
    const includeActive = existingColumns.has("active");
    const normalizedStatus = typeof input.status === "string"
        ? input.status.trim().toUpperCase()
        : null;
    const statusValue = typeof input.active === "boolean"
        ? input.active
            ? "ACTIVE"
            : "INACTIVE"
        : normalizedStatus === "ACTIVE" || normalizedStatus === "INACTIVE"
            ? normalizedStatus
            : "ACTIVE";
    const activeValue = statusValue === "ACTIVE";
    const columns = [
        { name: "id", value: "gen_random_uuid()", raw: true },
        { name: "name", value: name },
        { name: "country", value: country },
        { name: "website", value: website ?? null },
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
        value: input.submission_method ?? null,
    });
    columns.push({
        name: "submission_email",
        value: submission_email ?? null,
    });
    columns.push({
        name: "api_config",
        value: api_config ?? null,
    });
    if (existingColumns.has("submission_config")) {
        columns.push({
            name: "submission_config",
            value: submission_config ?? null,
        });
    }
    if (includeActive) {
        columns.push({ name: "active", value: activeValue });
    }
    const filteredColumns = columns.filter((entry) => existingColumns.has(entry.name) || entry.raw);
    const buildInsert = (entries) => {
        const values = [];
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
        const { rows } = await db.query(`
      INSERT INTO lenders (
        ${columnNames.join(",\n        ")}
      )
      VALUES (
        ${placeholders.join(",\n        ")}
      )
      RETURNING ${buildSelectColumns(existingColumns)}
    `, values);
        return rows[0];
    }
    catch (err) {
        const code = err.code;
        const message = err.message ?? "";
        if (code === "42883" || message.includes("gen_random_uuid")) {
            const adjustedColumns = filteredColumns.map((entry) => entry.raw
                ? { name: entry.name, value: (0, crypto_1.randomUUID)() }
                : entry);
            const columnNames = adjustedColumns.map((entry) => entry.name);
            const { values, placeholders } = buildInsert(adjustedColumns);
            const { rows } = await db.query(`
        INSERT INTO lenders (
          ${columnNames.join(",\n          ")}
        )
        VALUES (
          ${placeholders.join(",\n          ")}
        )
        RETURNING ${buildSelectColumns(existingColumns)}
      `, values);
            return rows[0];
        }
        throw err;
    }
}
async function updateLender(db, params) {
    const existingColumns = await fetchLenderColumns();
    const updates = [];
    const normalizedStatus = typeof params.status === "string"
        ? params.status.trim().toUpperCase()
        : null;
    const resolvedStatus = typeof params.active === "boolean"
        ? params.active
            ? "ACTIVE"
            : "INACTIVE"
        : normalizedStatus === "ACTIVE" || normalizedStatus === "INACTIVE"
            ? normalizedStatus
            : null;
    const resolvedActive = typeof params.active === "boolean"
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
    if (params.submission_method !== undefined &&
        existingColumns.has("submission_method")) {
        updates.push({ name: "submission_method", value: params.submission_method });
    }
    if (params.primary_contact_name !== undefined) {
        updates.push({ name: "primary_contact_name", value: params.primary_contact_name });
    }
    if (params.primary_contact_email !== undefined) {
        updates.push({ name: "primary_contact_email", value: params.primary_contact_email });
    }
    if (params.primary_contact_phone !== undefined) {
        updates.push({ name: "primary_contact_phone", value: params.primary_contact_phone });
    }
    if (params.submission_email !== undefined &&
        existingColumns.has("submission_email")) {
        updates.push({ name: "submission_email", value: params.submission_email });
    }
    if (params.api_config !== undefined && existingColumns.has("api_config")) {
        updates.push({ name: "api_config", value: params.api_config });
    }
    if (params.submission_config !== undefined &&
        existingColumns.has("submission_config")) {
        updates.push({ name: "submission_config", value: params.submission_config });
    }
    if (params.website !== undefined && existingColumns.has("website")) {
        updates.push({ name: "website", value: params.website });
    }
    if (resolvedActive !== undefined && existingColumns.has("active")) {
        updates.push({ name: "active", value: resolvedActive });
    }
    if (updates.length === 0) {
        return fetchLenderById(params.id);
    }
    const setClauses = updates.map((entry, index) => entry.name === "status"
        ? `${entry.name} = $${index + 1}::lender_status`
        : `${entry.name} = $${index + 1}`);
    const values = updates.map((entry) => entry.value);
    values.push(params.id);
    const { rows } = await db.query(`
    UPDATE lenders
    SET ${setClauses.join(", ")}
    WHERE id = $${values.length}
    RETURNING ${buildSelectColumns(existingColumns)}
    `, values);
    return rows[0] ?? null;
}
