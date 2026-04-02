import { pool, runQuery } from "../../db";
import { type PoolClient } from "pg";
import { formatPeriod, type GroupBy } from "./reporting.utils";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type DocumentMetricsRow = {
  period: string;
  documentType: string;
  documentsUploaded: number;
  documentsReviewed: number;
  documentsApproved: number;
};

function buildWhereClause(params: {
  column: string;
  from: Date | null;
  to: Date | null;
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
  return {
    clause: clauses.length > 0 ? `where ${clauses.join(" and ")}` : "",
    values,
  };
}

function periodExpression(groupBy: GroupBy): string {
  if (groupBy === "week") {
    return "date_trunc('week', metric_date)::date";
  }
  if (groupBy === "month") {
    return "date_trunc('month', metric_date)::date";
  }
  return "metric_date";
}

export async function listDocumentMetrics(params: {
  from: Date | null;
  to: Date | null;
  groupBy: GroupBy;
  limit: number;
  offset: number;
  documentType?: string | null;
  client?: Queryable;
}): Promise<DocumentMetricsRow[]> {
  const runner = params.client ?? pool;
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
  const res = await runner.query<{
    period: Date | string;
    document_type: string;
    documents_uploaded: number;
    documents_reviewed: number;
    documents_approved: number;
  }>(
    `select ${periodExpr} as period,
            document_type,
            sum(documents_uploaded)::int as documents_uploaded,
            sum(documents_reviewed)::int as documents_reviewed,
            sum(documents_approved)::int as documents_approved
     from reporting_document_metrics_daily
     ${documentClause}
     group by period, document_type
     order by period desc, document_type asc
     limit $${limitIndex} offset $${offsetIndex}`,
    [...values, params.limit, params.offset]
  );

  return res.rows.map((row) => ({
    period: formatPeriod(row.period),
    documentType: row.document_type,
    documentsUploaded: row.documents_uploaded,
    documentsReviewed: row.documents_reviewed,
    documentsApproved: row.documents_approved,
  }));
}
