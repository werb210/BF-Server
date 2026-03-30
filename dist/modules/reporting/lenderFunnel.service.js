"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLenderFunnel = listLenderFunnel;
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
async function listLenderFunnel(params) {
    const runner = params.client ?? db_1.pool;
    const { clause, values } = buildWhereClause({
        column: "metric_date",
        from: params.from,
        to: params.to,
    });
    if (params.lenderId) {
        values.push(params.lenderId);
    }
    const lenderClause = params.lenderId
        ? `${clause ? `${clause} and` : "where"} lender_id = $${values.length}`
        : clause;
    const periodExpr = periodExpression(params.groupBy);
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const res = await runner.query(`select ${periodExpr} as period,
            lender_id,
            sum(submissions)::int as submissions,
            sum(approvals)::int as approvals,
            sum(funded)::int as funded
     from reporting_lender_funnel_daily
     ${lenderClause}
     group by period, lender_id
     order by period desc, lender_id asc
     limit $${limitIndex} offset $${offsetIndex}`, [...values, params.limit, params.offset]);
    return res.rows.map((row) => ({
        period: (0, reporting_utils_1.formatPeriod)(row.period),
        lenderId: row.lender_id,
        submissions: row.submissions,
        approvals: row.approvals,
        funded: row.funded,
    }));
}
