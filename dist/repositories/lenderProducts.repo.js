"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIST_LENDER_PRODUCTS_SQL = void 0;
exports.createLenderProduct = createLenderProduct;
exports.listLenderProducts = listLenderProducts;
exports.listLenderProductsByLenderId = listLenderProductsByLenderId;
exports.fetchLenderProductById = fetchLenderProductById;
exports.updateLenderProduct = updateLenderProduct;
const collectionSafe_1 = require("../utils/collectionSafe");
const crypto_1 = require("crypto");
const db_1 = require("../db");
const errors_1 = require("../middleware/errors");
const logger_1 = require("../observability/logger");
const LENDER_PRODUCTS_REPO = "src/repositories/lenderProducts.repo.ts";
const LENDER_PRODUCTS_TABLE = "lender_products";
async function assertLenderProductColumnsExist(params) {
    try {
        const result = await params.client.query(`select column_name
       from information_schema.columns
       where table_schema = 'public'
         and table_name = $1`, [LENDER_PRODUCTS_TABLE]);
        const existing = (0, collectionSafe_1.toStringSet)(result.rows.map((row) => row.column_name));
        const missing = params.columns.filter((column) => !existing.has(column));
        if (missing.length === 0) {
            return existing;
        }
        for (const column of missing) {
            (0, logger_1.logError)("schema_column_missing", {
                route: params.route,
                repository: LENDER_PRODUCTS_REPO,
                column,
                table: LENDER_PRODUCTS_TABLE,
            });
        }
        if (!params.allowMissing) {
            throw new errors_1.AppError("db_schema_error", `Missing columns on ${LENDER_PRODUCTS_TABLE}: ${missing.join(", ")}`, 500);
        }
        return existing;
    }
    catch (err) {
        if (err instanceof errors_1.AppError) {
            throw err;
        }
        (0, logger_1.logError)("schema_column_check_failed", {
            route: params.route,
            repository: LENDER_PRODUCTS_REPO,
            table: LENDER_PRODUCTS_TABLE,
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
async function createLenderProduct(params) {
    const runner = params.client ?? db_1.pool;
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
        { name: "id", value: (0, crypto_1.randomUUID)() },
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
    const res = await runner.query(`insert into lender_products
     (${columnNames.join(", ")}, created_at, updated_at)
     values (${placeholders.join(", ")}, now(), now())
     returning ${selectColumns}`, values);
    const rows = res.rows;
    const created = rows[0];
    if (!created) {
        throw new errors_1.AppError("db_error", "Failed to create lender product.", 500);
    }
    return created;
}
exports.LIST_LENDER_PRODUCTS_SQL = `select id,
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
async function listLenderProducts(client) {
    const runner = client ?? db_1.pool;
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
        const res = await runner.query(`select ${selectColumns}
       from lender_products
       order by created_at desc`);
        return res.rows;
    }
    catch (err) {
        (0, logger_1.logError)("lender_products_query_failed", {
            sql: exports.LIST_LENDER_PRODUCTS_SQL,
            params: [],
            stack: err instanceof Error ? err.stack : undefined,
        });
        const error = err instanceof Error ? err : new Error("Unknown database error.");
        const appError = new errors_1.AppError("db_error", error.message, 500);
        if (error.stack) {
            appError.stack = error.stack;
        }
        throw appError;
    }
}
async function listLenderProductsByLenderId(lenderId, client) {
    const runner = client ?? db_1.pool;
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
    const res = await runner.query(`select ${selectColumns}
     from lender_products
     where lender_id = $1
     order by created_at desc`, [lenderId]);
    return res.rows;
}
async function fetchLenderProductById(id, client) {
    const runner = client ?? db_1.pool;
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
    const res = await runner.query(`select ${selectColumns}
     from lender_products
     where id = $1
     limit 1`, [id]);
    return res.rows[0] ?? null;
}
async function updateLenderProduct(params) {
    const runner = params.client ?? db_1.pool;
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
    const updates = [
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
    const setClauses = updates.map((entry, index) => `${entry.name} = $${index + 1}${entry.cast ?? ""}`);
    const values = updates.map((entry) => entry.value);
    values.push(params.id);
    const selectColumns = buildSelectColumns(existing);
    const res = await runner.query(`update lender_products
     set ${setClauses.join(", ")},
         updated_at = now()
     where id = $${values.length}
     returning ${selectColumns}`, values);
    return res.rows[0] ?? null;
}
