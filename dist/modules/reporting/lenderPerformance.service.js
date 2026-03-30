"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLenderPerformance = listLenderPerformance;
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
        return "date_trunc('week', period_start)::date";
    }
    if (groupBy === "month") {
        return "date_trunc('month', period_start)::date";
    }
    return "period_start";
}
async function listLenderPerformance(params) {
    const runner = params.client ?? db_1.pool;
    const { clause, values } = buildWhereClause({
        column: "period_start",
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
            sum(declines)::int as declines,
            sum(funded)::int as funded,
            avg(avg_decision_time_seconds)::int as avg_decision_time_seconds
     from reporting_lender_performance
     ${lenderClause}
     group by period, lender_id
     order by period desc, lender_id asc
     limit $${limitIndex} offset $${offsetIndex}`, [...values, params.limit, params.offset]);
    return res.rows.map((row) => ({
        period: (0, reporting_utils_1.formatPeriod)(row.period),
        lenderId: row.lender_id,
        submissions: row.submissions,
        approvals: row.approvals,
        declines: row.declines,
        funded: row.funded,
        avgDecisionTimeSeconds: row.avg_decision_time_seconds,
    }));
}
