"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDocumentMetrics = listDocumentMetrics;
const db_1 = require("../../db");
const reporting_utils_1 = require("./reporting.utils");
function buildWhereClause(params) {
    const clauses = [];
    const values = [];
    if (params.from) {
        values.push(params.from);
        clauses.push(`${params.column} >= $${values.length}`);
    }
    if (params.to) {
        values.push(params.to);
        clauses.push(`${params.column} < $${values.length}`);
    }
    return {
        clause: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
        values,
    };
}
function periodExpression(groupBy) {
    if (groupBy === "week") {
        return "date_trunc('week', metric_date)::date";
    }
    if (groupBy === "month") {
        return "date_trunc('month', metric_date)::date";
    }
    return "metric_date";
}
async function listDocumentMetrics(params) {
    const runner = params.client ?? db_1.pool;
    const { clause, values } = buildWhereClause({
        column: "metric_date",
        from: params.from,
        to: params.to,
    });
    if (params.documentType) {
        values.push(params.documentType);
    }
    const documentClause = params.documentType
        ? `${clause ? `${clause} and` : "where"} document_type = $${values.length}`
        : clause;
    const periodExpr = periodExpression(params.groupBy);
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const res = await runner.query(`select ${periodExpr} as period,
            document_type,
            sum(documents_uploaded)::int as documents_uploaded,
            sum(documents_reviewed)::int as documents_reviewed,
            sum(documents_approved)::int as documents_approved
     from reporting_document_metrics_daily
     ${documentClause}
     group by period, document_type
     order by period desc, document_type asc
     limit $${limitIndex} offset $${offsetIndex}`, [...values, params.limit, params.offset]);
    return res.rows.map((row) => ({
        period: (0, reporting_utils_1.formatPeriod)(row.period),
        documentType: row.document_type,
        documentsUploaded: row.documents_uploaded,
        documentsReviewed: row.documents_reviewed,
        documentsApproved: row.documents_approved,
    }));
}
