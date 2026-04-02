import { pool, runQuery } from "../../db";
import { type PoolClient } from "pg";
import { formatPeriod, type GroupBy } from "./reporting.utils";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type StaffActivityRow = {
  period: string;
  staffUserId: string;
  action: string;
  activityCount: number;
};

function buildWhereClause(params: {
  from: Date | null;
  to: Date | null;
  staffUserId?: string | null;
  action?: string | null;
}): { clause: string; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
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

function periodExpression(groupBy: GroupBy): string {
  if (groupBy === "week") {
    return "date_trunc('week', metric_date)::date";
  }
  if (groupBy === "month") {
    return "date_trunc('month', metric_date)::date";
  }
  return "metric_date";
}

export async function listStaffActivity(params: {
  from: Date | null;
  to: Date | null;
  groupBy: GroupBy;
  limit: number;
  offset: number;
  staffUserId?: string | null;
  action?: string | null;
  client?: Queryable;
}): Promise<StaffActivityRow[]> {
  const runner = params.client ?? pool;
  const { clause, values } = buildWhereClause({
    from: params.from,
    to: params.to,
    staffUserId: params.staffUserId ?? null,
    action: params.action ?? null,
  });
  const periodExpr = periodExpression(params.groupBy);
  const limitIndex = values.length + 1;
  const offsetIndex = values.length + 2;
  const res = await runner.query<{
    period: Date | string;
    staff_user_id: string;
    action: string;
    activity_count: number;
  }>(
    `select ${periodExpr} as period,
            staff_user_id,
            action,
            sum(activity_count)::int as activity_count
     from reporting_staff_activity_daily
     ${clause}
     group by period, staff_user_id, action
     order by period desc, staff_user_id asc, action asc
     limit $${limitIndex} offset $${offsetIndex}`,
    [...values, params.limit, params.offset]
  );

  return res.rows.map((row) => ({
    period: formatPeriod(row.period),
    staffUserId: row.staff_user_id,
    action: row.action,
    activityCount: row.activity_count,
  }));
}
