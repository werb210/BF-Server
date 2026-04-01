import { pool } from "../../db";
import { type PoolClient } from "pg";
import { formatPeriod, type GroupBy } from "./reporting.utils";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type DailyMetricsRow = {
  period: string;
  applicationsCreated: number;
  applicationsSubmitted: number;
  applicationsApproved: number;
  applicationsDeclined: number;
  applicationsFunded: number;
  documentsUploaded: number;
  documentsApproved: number;
  lenderSubmissions: number;
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

export async function listDailyMetrics(params: {
  from: Date | null;
  to: Date | null;
  groupBy: GroupBy;
  limit: number;
  offset: number;
  client?: Queryable;
}): Promise<DailyMetricsRow[]> {
  const runner = params.client ?? pool;
  const { clause, values } = buildWhereClause({
    column: "metric_date",
    from: params.from,
    to: params.to,
  });
  const periodExpr = periodExpression(params.groupBy);
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const res = await runner.query<{
    period: Date | string;
    applications_created: number;
    applications_submitted: number;
    applications_approved: number;
    applications_declined: number;
    applications_funded: number;
    documents_uploaded: number;
    documents_approved: number;
    lender_submissions: number;
  }>(
    `select ${periodExpr} as period,
            sum(applications_created)::int as applications_created,
            sum(applications_submitted)::int as applications_submitted,
            sum(applications_approved)::int as applications_approved,
            sum(applications_declined)::int as applications_declined,
            sum(applications_funded)::int as applications_funded,
            sum(documents_uploaded)::int as documents_uploaded,
            sum(documents_approved)::int as documents_approved,
            sum(lender_submissions)::int as lender_submissions
     from reporting_daily_metrics
     ${clause}
     group by period
     order by period desc
     limit $${limitIndex} offset $${offsetIndex}`,
    [...values, params.limit, params.offset]
  );

  return res.rows.map((row) => ({
    period: formatPeriod(row.period),
    applicationsCreated: row.applications_created,
    applicationsSubmitted: row.applications_submitted,
    applicationsApproved: row.applications_approved,
    applicationsDeclined: row.applications_declined,
    applicationsFunded: row.applications_funded,
    documentsUploaded: row.documents_uploaded,
    documentsApproved: row.documents_approved,
    lenderSubmissions: row.lender_submissions,
  }));
}

export async function computeDailyMetricsForDate(params: {
  start: Date;
  end: Date;
  client?: Queryable;
}): Promise<Omit<DailyMetricsRow, "period">> {
  const runner = params.client ?? pool;
  const res = await runner.query<{
    applications_created: number;
    applications_submitted: number;
    applications_approved: number;
    applications_declined: number;
    applications_funded: number;
    documents_uploaded: number;
    documents_approved: number;
    lender_submissions: number;
  }>(
    `select
       (select count(*)::int from applications where created_at >= $1 and created_at < $2) as applications_created,
       (select count(*)::int from applications where pipeline_state = 'OFF_TO_LENDER' and updated_at >= $1 and updated_at < $2) as applications_submitted,
       (select count(*)::int from applications where pipeline_state = 'ACCEPTED' and updated_at >= $1 and updated_at < $2) as applications_approved,
       (select count(*)::int from applications where pipeline_state = 'REJECTED' and updated_at >= $1 and updated_at < $2) as applications_declined,
       (select count(*)::int from applications where pipeline_state = 'ACCEPTED' and updated_at >= $1 and updated_at < $2) as applications_funded,
       (select count(*)::int from document_versions where created_at >= $1 and created_at < $2) as documents_uploaded,
       (select count(*)::int from document_version_reviews where status = 'accepted' and reviewed_at >= $1 and reviewed_at < $2) as documents_approved,
       (select count(*)::int from lender_submissions where created_at >= $1 and created_at < $2) as lender_submissions`,
    [params.start, params.end]
  );

  const row = res.rows[0];
  if (!row) {
    return {
      applicationsCreated: 0,
      applicationsSubmitted: 0,
      applicationsApproved: 0,
      applicationsDeclined: 0,
      applicationsFunded: 0,
      documentsUploaded: 0,
      documentsApproved: 0,
      lenderSubmissions: 0,
    };
  }
  return {
    applicationsCreated: row.applications_created,
    applicationsSubmitted: row.applications_submitted,
    applicationsApproved: row.applications_approved,
    applicationsDeclined: row.applications_declined,
    applicationsFunded: row.applications_funded,
    documentsUploaded: row.documents_uploaded,
    documentsApproved: row.documents_approved,
    lenderSubmissions: row.lender_submissions,
  };
}
