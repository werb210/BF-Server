"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listStaffActivity = listStaffActivity;
const db_1 = require("../../db");
const reporting_utils_1 = require("./reporting.utils");
function buildWhereClause(params) {
    const clauses = [];
    const values = [];
    if (params.from) {
        values.push(params.from);
        clauses.push(`metric_date >= $${values.length}`);
    }
    if (params.to) {
        values.push(params.to);
        clauses.push(`metric_date < $${values.length}`);
    }
    if (params.staffUserId) {
        values.push(params.staffUserId);
        clauses.push(`staff_user_id = $${values.length}`);
    }
    if (params.action) {
        values.push(params.action);
        clauses.push(`action = $${values.length}`);
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
async function listStaffActivity(params) {
    const runner = params.client ?? db_1.pool;
    const { clause, values } = buildWhereClause({
        from: params.from,
        to: params.to,
        staffUserId: params.staffUserId ?? null,
        action: params.action ?? null,
    });
    const periodExpr = periodExpression(params.groupBy);
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const res = await runner.query(`select ${periodExpr} as period,
            staff_user_id,
            action,
            sum(activity_count)::int as activity_count
     from reporting_staff_activity_daily
     ${clause}
     group by period, staff_user_id, action
     order by period desc, staff_user_id asc, action asc
     limit $${limitIndex} offset $${offsetIndex}`, [...values, params.limit, params.offset]);
    return res.rows.map((row) => ({
        period: (0, reporting_utils_1.formatPeriod)(row.period),
        staffUserId: row.staff_user_id,
        action: row.action,
        activityCount: row.activity_count,
    }));
}
