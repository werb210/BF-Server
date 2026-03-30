"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordExportAudit = recordExportAudit;
exports.listRecentExports = listRecentExports;
exports.exportPipelineSummary = exportPipelineSummary;
exports.exportLenderPerformance = exportLenderPerformance;
exports.exportApplicationVolume = exportApplicationVolume;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const pg_1 = require("pg");
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
    params.extra?.forEach((item) => {
        if (item.value) {
            values.push(item.value);
            clauses.push(`${item.column} = $${values.length}`);
        }
    });
    return {
        clause: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
        values,
    };
}
async function recordExportAudit(params) {
    await db_1.pool.query(`insert into export_audit (id, actor_user_id, export_type, filters, created_at)
     values ($1, $2, $3, $4, now())`, [(0, crypto_1.randomUUID)(), params.actorUserId, params.exportType, JSON.stringify(params.filters)]);
}
async function listRecentExports(limit = 20) {
    const result = await db_1.pool.query(`select id, actor_user_id, export_type, filters, created_at
     from export_audit
     order by created_at desc
     limit $1`, [limit]);
    return result.rows.map((row) => ({
        id: row.id,
        actorUserId: row.actor_user_id,
        exportType: row.export_type,
        filters: row.filters,
        createdAt: row.created_at.toISOString(),
    }));
}
function csvValue(value) {
    if (value === null || value === undefined) {
        return "";
    }
    const text = value instanceof Date
        ? value.toISOString()
        : typeof value === "string"
            ? value
            : JSON.stringify(value);
    if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
}
async function streamQueryAsCsv(params) {
    const client = await db_1.pool.connect();
    const query = new pg_1.Query(params.query, params.values);
    return new Promise((resolve, reject) => {
        query.on("row", (row) => {
            const line = params.columns.map((col) => csvValue(row[col])).join(",");
            params.write(`${line}\n`);
        });
        query.on("error", (err) => {
            client.release();
            reject(err);
        });
        query.on("end", () => {
            client.release();
            resolve();
        });
        client.query(query);
    });
}
async function exportPipelineSummary(params) {
    const { clause, values } = buildWhereClause({
        column: "snapshot_date",
        from: params.filters.from,
        to: params.filters.to,
        extra: [
            {
                column: "pipeline_state",
                value: params.filters.pipelineState ?? null,
            },
        ],
    });
    const query = `select snapshot_date, pipeline_state, application_count
                 from reporting_pipeline_daily_snapshots
                 ${clause}
                 order by snapshot_date desc,
                          ${PIPELINE_ORDER_CASE_SQL} asc`;
    if (params.format === "csv" && params.write) {
        params.write("snapshot_date,pipeline_state,application_count\n");
        await streamQueryAsCsv({
            query,
            values,
            columns: ["snapshot_date", "pipeline_state", "application_count"],
            write: params.write,
        });
        return [];
    }
    const result = await db_1.pool.query(query, values);
    return result.rows;
}
async function exportLenderPerformance(params) {
    const { clause, values } = buildWhereClause({
        column: "period_start",
        from: params.filters.from,
        to: params.filters.to,
        extra: [
            {
                column: "lender_id",
                value: params.filters.lenderId ?? null,
            },
        ],
    });
    const query = `select lender_id, period_start, period_end, submissions, approvals, declines, funded,
                        avg_decision_time_seconds
                 from reporting_lender_performance
                 ${clause}
                 order by period_start desc, lender_id asc`;
    if (params.format === "csv" && params.write) {
        params.write("lender_id,period_start,period_end,submissions,approvals,declines,funded,avg_decision_time_seconds\n");
        await streamQueryAsCsv({
            query,
            values,
            columns: [
                "lender_id",
                "period_start",
                "period_end",
                "submissions",
                "approvals",
                "declines",
                "funded",
                "avg_decision_time_seconds",
            ],
            write: params.write,
        });
        return [];
    }
    const result = await db_1.pool.query(query, values);
    return result.rows;
}
async function exportApplicationVolume(params) {
    const { clause, values } = buildWhereClause({
        column: "metric_date",
        from: params.filters.from,
        to: params.filters.to,
        extra: [
            {
                column: "product_type",
                value: params.filters.productType ?? null,
            },
        ],
    });
    const query = `select metric_date, product_type, applications_created, applications_submitted,
                        applications_approved, applications_declined, applications_funded
                 from reporting_application_volume_daily
                 ${clause}
                 order by metric_date desc, product_type asc`;
    if (params.format === "csv" && params.write) {
        params.write("metric_date,product_type,applications_created,applications_submitted,applications_approved,applications_declined,applications_funded\n");
        await streamQueryAsCsv({
            query,
            values,
            columns: [
                "metric_date",
                "product_type",
                "applications_created",
                "applications_submitted",
                "applications_approved",
                "applications_declined",
                "applications_funded",
            ],
            write: params.write,
        });
        return [];
    }
    const result = await db_1.pool.query(query, values);
    return result.rows;
}
