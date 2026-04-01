"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertRequiredSchema = assertRequiredSchema;
const db_1 = require("../db");
const requiredColumns = [
    { table: "users", column: "lender_id" },
    { table: "lenders", column: "id" },
    { table: "lenders", column: "country" },
    { table: "lenders", column: "submission_method" },
    { table: "lenders", column: "submission_config" },
    { table: "lenders", column: "google_sheet_id" },
    { table: "lenders", column: "google_sheet_tab" },
    { table: "lenders", column: "google_sheet_mapping" },
    { table: "lender_products", column: "lender_id" },
    { table: "lender_products", column: "required_documents" },
    { table: "lender_product_requirements", column: "id" },
    { table: "lender_product_requirements", column: "lender_product_id" },
    { table: "lender_product_requirements", column: "document_type" },
    { table: "lender_product_requirements", column: "created_at" },
    { table: "ai_knowledge_documents", column: "id" },
    { table: "ai_knowledge_chunks", column: "id" },
    { table: "chat_sessions", column: "id" },
    { table: "chat_messages", column: "id" },
    { table: "issue_reports", column: "id" },
    { table: "ai_prequal_sessions", column: "id" },
    { table: "pre_applications", column: "id" },
];
async function assertRequiredSchema() {
    const values = requiredColumns
        .map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`)
        .join(", ");
    const params = requiredColumns.flatMap((entry) => [entry.table, entry.column]);
    const query = `
    select req.table_name, req.column_name
    from (values ${values}) as req(table_name, column_name)
    left join information_schema.columns cols
      on cols.table_schema = 'public'
      and cols.table_name = req.table_name
      and cols.column_name = req.column_name
    where cols.column_name is null
  `;
    const res = await db_1.pool.runQuery(query, params);
    if (res.rows.length === 0) {
        return;
    }
    const missing = res.rows.map((row) => `${row.table_name}.${row.column_name}`);
    throw new Error(`schema mismatch: missing columns: ${missing.join(", ")}`);
}
