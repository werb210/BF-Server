import { pool } from "../../db";
import { type PoolClient } from "pg";
import { formatPeriod, type GroupBy } from "./reporting.utils";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type ApplicationVolumeRow = {
  period: string;
  productType: string;
  applicationsCreated: number;
  applicationsSubmitted: number;
  applicationsApproved: number;
  applicationsDeclined: number;
  applicationsFunded: number;
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

export async function listApplicationVolume(params: {
  from: Date | null;
  to: Date | null;
  groupBy: GroupBy;
  limit: number;
  offset: number;
  productType?: string | null;
  client?: Queryable;
}): Promise<ApplicationVolumeRow[]> {
  const runner = params.client ?? pool;
  const { clause, values } = buildWhereClause({
    column: "metric_date",
    from: params.from,
    to: params.to,
  });
  if (params.productType) {
    values.push(params.productType);
  }
  const productClause = params.productType
    ? `${clause ? `${clause} and` : "where"} product_type = $${values.length}`
    : clause;
  const periodExpr = periodExpression(params.groupBy);
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const res = await runner.query<{
    period: Date | string;
    product_type: string;
    applications_created: number;
    applications_submitted: number;
    applications_approved: number;
    applications_declined: number;
    applications_funded: number;
  }>(
    `select ${periodExpr} as period,
            product_type,
            sum(applications_created)::int as applications_created,
            sum(applications_submitted)::int as applications_submitted,
            sum(applications_approved)::int as applications_approved,
            sum(applications_declined)::int as applications_declined,
            sum(applications_funded)::int as applications_funded
     from reporting_application_volume_daily
     ${productClause}
     group by period, product_type
     order by period desc, product_type asc
     limit $${limitIndex} offset $${offsetIndex}`,
    [...values, params.limit, params.offset]
  );

  return res.rows.map((row) => ({
    period: formatPeriod(row.period),
    productType: row.product_type,
    applicationsCreated: row.applications_created,
    applicationsSubmitted: row.applications_submitted,
    applicationsApproved: row.applications_approved,
    applicationsDeclined: row.applications_declined,
    applicationsFunded: row.applications_funded,
  }));
}
