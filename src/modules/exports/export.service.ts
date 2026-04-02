import { randomUUID } from "crypto";
import { pool, runQuery } from "../../db";
import { Query } from "pg";
import { PIPELINE_STATES } from "../applications/pipelineState";

export type ExportFormat = "json" | "csv";

export type ExportFilters = {
  from: Date | null;
  to: Date | null;
  pipelineState?: string | null;
  lenderId?: string | null;
  productType?: string | null;
};

const PIPELINE_ORDER_CASE_SQL = `case pipeline_state ${PIPELINE_STATES.map(
  (state, index) => `when '${state}' then ${index + 1}`
).join(" ")} else 999 end`;

function buildWhereClause(params: {
  column: string;
  from: Date | null;
  to: Date | null;
  extra?: Array<{ column: string; value: string | null | undefined }>;
}): { clause: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
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

export async function recordExportAudit(params: {
  actorUserId: string | null;
  exportType: string;
  filters: ExportFilters;
}): Promise<void> {
  await runQuery(
    `insert into export_audit (id, actor_user_id, export_type, filters, created_at)
     values ($1, $2, $3, $4, now())`,
    [randomUUID(), params.actorUserId, params.exportType, JSON.stringify(params.filters)]
  );
}

export async function listRecentExports(limit = 20): Promise<
  Array<{
    id: string;
    actorUserId: string | null;
    exportType: string;
    filters: unknown;
    createdAt: string;
  }>
> {
  const result = await runQuery<{
    id: string;
    actor_user_id: string | null;
    export_type: string;
    filters: unknown;
    created_at: Date;
  }>(
    `select id, actor_user_id, export_type, filters, created_at
     from export_audit
     order by created_at desc
     limit $1`,
    [limit]
  );
  return result.rows.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    exportType: row.export_type,
    filters: row.filters,
    createdAt: row.created_at.toISOString(),
  }));
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

async function streamQueryAsCsv(params: {
  query: string;
  values: unknown[];
  columns: string[];
  write: (chunk: string) => void;
}): Promise<void> {
  const client = await pool.connect();
  const query = new Query(params.query, params.values);
  return new Promise((resolve, reject) => {
    query.on("row", (row: Record<string, unknown>) => {
      const line = params.columns.map((col) => csvValue(row[col])).join(",");
      params.write(`${line}\n`);
    });
    query.on("error", (err: Error) => {
      client.release();
      reject(err);
    });
    query.on("end", () => {
      client.release();
      resolve();
    });
    (client as any)["query"](query);
  });
}

export async function exportPipelineSummary(params: {
  filters: ExportFilters;
  format: ExportFormat;
  write?: (chunk: string) => void;
}): Promise<Record<string, unknown>[]> {
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

  const result = await runQuery(query, values);
  return result.rows;
}

export async function exportLenderPerformance(params: {
  filters: ExportFilters;
  format: ExportFormat;
  write?: (chunk: string) => void;
}): Promise<Record<string, unknown>[]> {
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
    params.write(
      "lender_id,period_start,period_end,submissions,approvals,declines,funded,avg_decision_time_seconds\n"
    );
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

  const result = await runQuery(query, values);
  return result.rows;
}

export async function exportApplicationVolume(params: {
  filters: ExportFilters;
  format: ExportFormat;
  write?: (chunk: string) => void;
}): Promise<Record<string, unknown>[]> {
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
    params.write(
      "metric_date,product_type,applications_created,applications_submitted,applications_approved,applications_declined,applications_funded\n"
    );
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

  const result = await runQuery(query, values);
  return result.rows;
}
