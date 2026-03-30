"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listPipelineSnapshots = listPipelineSnapshots;
exports.listCurrentPipelineState = listCurrentPipelineState;
const db_1 = require("../../db");
const reporting_utils_1 = require("./reporting.utils");
const pipelineState_1 = require("../applications/pipelineState");
const PIPELINE_ORDER_CASE_SQL = `case pipeline_state ${pipelineState_1.PIPELINE_STATES.map((state, index) => `when '${state}' then ${index + 1}`).join(" ")} else 999 end`;
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
        return "date_trunc('week', snapshot_date)::date";
    }
    if (groupBy === "month") {
        return "date_trunc('month', snapshot_date)::date";
    }
    return "snapshot_date";
}
async function listPipelineSnapshots(params) {
    const runner = params.client ?? db_1.pool;
    const { clause, values } = buildWhereClause({
        column: "snapshot_date",
        from: params.from,
        to: params.to,
    });
    if (params.pipelineState) {
        values.push(params.pipelineState);
    }
    const stateClause = params.pipelineState
        ? `${clause ? `${clause} and` : "where"} pipeline_state = $${values.length}`
        : clause;
    const periodExpr = periodExpression(params.groupBy);
    const limitIndex = values.length + 1;
    const offsetIndex = values.length + 2;
    const res = await runner.query(`select ${periodExpr} as period,
            pipeline_state,
            sum(application_count)::int as application_count
     from reporting_pipeline_daily_snapshots
     ${stateClause}
     group by period, pipeline_state
     order by period desc,
              ${PIPELINE_ORDER_CASE_SQL} asc
     limit $${limitIndex} offset $${offsetIndex}`, [...values, params.limit, params.offset]);
    return res.rows.map((row) => ({
        period: (0, reporting_utils_1.formatPeriod)(row.period),
        pipelineState: row.pipeline_state,
        applicationCount: row.application_count,
    }));
}
async function listCurrentPipelineState(params) {
    const runner = params?.client ?? db_1.pool;
    const res = await runner.query(`select pipeline_state, application_count
     from vw_pipeline_current_state`);
    const rows = Array.isArray(res.rows) ? res.rows : [];
    const countsByState = new Map();
    rows.forEach((row) => {
        if (row.pipeline_state) {
            countsByState.set(row.pipeline_state.toLowerCase(), row.application_count);
        }
    });
    const normalizedDefaults = pipelineState_1.PIPELINE_STATES.map((state) => ({
        pipelineState: state,
        applicationCount: countsByState.get(state.toLowerCase()) ?? 0,
    }));
    const knownStates = new Set(pipelineState_1.PIPELINE_STATES.map((state) => state.toLowerCase()));
    const extras = rows
        .filter((row) => row.pipeline_state && !knownStates.has(row.pipeline_state.toLowerCase()))
        .map((row) => ({
        pipelineState: row.pipeline_state ?? "RECEIVED",
        applicationCount: row.application_count,
    }));
    return [...normalizedDefaults, ...extras];
}
