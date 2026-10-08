// BF_SERVER_REPORTS15_18_v786 - pipeline snapshots, issues, and the custom report builder. Boreal Financial silo.
import { pool } from "../../db.js";
import type { Ctx } from "./data2.js";
import { ALBERTA_TZ } from "../../lib/albertaTime.js";

function days(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1095) : fallback;
}
const r1 = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
const STAFF = (alias: string) => `COALESCE(NULLIF(TRIM(COALESCE(${alias}.first_name, '') || ' ' || COALESCE(${alias}.last_name, '')), ''), ${alias}.email, 'Unassigned')`;

/** Store today's pipeline by stage (open files only). Safe to run many times a day: the latest run wins. */
export async function takePipelineSnapshot(): Promise<number> {
  const r = await pool.query(
    `INSERT INTO pipeline_snapshots (snapshot_date, stage, files, amount, taken_at)
     SELECT (now() AT TIME ZONE $1)::date, COALESCE(NULLIF(a.pipeline_state, ''), 'Unknown'), count(*)::int, COALESCE(sum(a.requested_amount), 0), now()
       FROM applications a
      WHERE a.silo = 'BF' AND a.funded_at IS NULL AND COALESCE(a.status, '') <> 'DECLINED'
        AND COALESCE(a.pipeline_state, '') NOT ILIKE 'reject%' AND COALESCE(a.is_completed, false) = false
      GROUP BY 2
     ON CONFLICT (snapshot_date, stage) DO UPDATE SET files = EXCLUDED.files, amount = EXCLUDED.amount, taken_at = now()`, [ALBERTA_TZ]); // Alberta is UTC-6 all year
  return r.rowCount ?? 0;
}

/** 15. The pipeline on a chosen past day (default: the earliest of the last 30 days), next to today. */
export async function pipelineSnapshot(q: Record<string, unknown>) {
  const dates = (await pool.query(`SELECT to_char(snapshot_date, 'YYYY-MM-DD') AS d FROM pipeline_snapshots GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 400`)).rows.map((r: any) => r.d as string);
  const wanted = typeof q.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? q.date : (dates.find((d) => d <= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)) ?? dates[dates.length - 1] ?? null);
  const today = dates[0] ?? null;
  const at = async (d: string | null) => d ? (await pool.query(`SELECT stage, files, amount FROM pipeline_snapshots WHERE snapshot_date = $1::date`, [d])).rows : [];
  const [then, now] = await Promise.all([at(wanted), at(today)]);
  const stages = Array.from(new Set([...then, ...now].map((r: any) => r.stage)));
  return {
    date: wanted, today, dates,
    note: dates.length ? `History starts ${dates[dates.length - 1]}.` : "The first snapshot is taken within an hour of this report going live.",
    rows: stages.map((s) => {
      const a: any = then.find((r: any) => r.stage === s); const b: any = now.find((r: any) => r.stage === s);
      return { stage: s, then_files: a?.files ?? 0, then_amount: Math.round(Number(a?.amount ?? 0)), now_files: b?.files ?? 0, now_amount: Math.round(Number(b?.amount ?? 0)) };
    }),
  };
}

/** 16. Issues: opened and resolved per month, median days to resolve, and what is open now. */
export async function issuesReport(q: Record<string, unknown>) {
  const d = days(q.days, 180);
  const byMonth = (await pool.query(
    `SELECT to_char(date_trunc('month', i.created_at), 'YYYY-MM') AS label, count(*)::int AS opened,
            count(*) FILTER (WHERE i.status = 'resolved')::int AS resolved,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (i.updated_at - i.created_at)) / 86400) FILTER (WHERE i.status = 'resolved') AS median_days
       FROM issues i WHERE COALESCE(i.silo, 'BF') = 'BF' AND i.created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [d])).rows.map((r: any) => ({ label: r.label, opened: r.opened, resolved: r.resolved, median_days: r1(r.median_days) }));
  const open = (await pool.query(
    `SELECT COALESCE(NULLIF(i.kind, ''), NULLIF(i.source, ''), 'Other') AS label, count(*)::int AS open,
            count(*) FILTER (WHERE i.status = 'in_progress')::int AS in_progress,
            max(EXTRACT(EPOCH FROM (now() - i.created_at)) / 86400)::int AS oldest_days
       FROM issues i WHERE COALESCE(i.silo, 'BF') = 'BF' AND COALESCE(i.status, 'open') <> 'resolved'
      GROUP BY 1 ORDER BY 2 DESC`)).rows;
  return { days: d, note: "Time to resolve uses the issue's last update, so a resolved issue edited later shows longer.", byMonth, open };
}

// 18. Custom report builder: a fixed menu of record types, groupings and measures (no free-form SQL).
type Entity = { from: string; where: string; date: string; groups: Record<string, string>; measures: Record<string, string> };
const MONTH = (col: string) => `to_char(date_trunc('month', ${col}), 'YYYY-MM')`;
export const CUSTOM: Record<string, Entity> = {
  applications: {
    from: "applications a LEFT JOIN users u ON u.id = a.owner_user_id", where: "a.silo = 'BF'", date: "a.created_at",
    groups: { stage: "COALESCE(NULLIF(a.pipeline_state, ''), 'Unknown')", product: "COALESCE(NULLIF(a.product_category, ''), 'Other')", source: "COALESCE(NULLIF(a.source, ''), 'Direct')", owner: STAFF("u"), month: MONTH("a.created_at") },
    measures: { count: "count(*)", amount: "COALESCE(sum(a.requested_amount), 0)", funded: "count(*) FILTER (WHERE a.funded_at IS NOT NULL)", average_amount: "COALESCE(avg(a.requested_amount), 0)" },
  },
  contacts: {
    from: "contacts c LEFT JOIN users u ON u.id = c.owner_id", where: "c.silo = 'BF'", date: "c.created_at",
    groups: { lifecycle: "COALESCE(NULLIF(c.lifecycle_stage, ''), 'lead')", owner: STAFF("u"), month: MONTH("c.created_at") },
    measures: { count: "count(*)", opted_out: "count(*) FILTER (WHERE c.sms_opt_out = true)" },
  },
  tasks: {
    from: "tasks t LEFT JOIN users u ON u.id = t.assignee_user_id", where: "t.deleted_at IS NULL AND COALESCE(t.silo, 'BF') = 'BF'", date: "t.created_at",
    groups: { status: "COALESCE(NULLIF(t.status, ''), 'open')", assignee: STAFF("u"), type: "COALESCE(NULLIF(t.type, ''), 'task')", month: MONTH("t.created_at") },
    measures: { count: "count(*)", overdue: "count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_at < now())", completed: "count(*) FILTER (WHERE t.completed_at IS NOT NULL)" },
  },
};

export async function customReport(q: Record<string, unknown>, _ctx?: Ctx) {
  const entityKey = String(q.entity ?? "applications");
  const e = CUSTOM[entityKey];
  const menu = Object.fromEntries(Object.entries(CUSTOM).map(([k, v]) => [k, { groups: Object.keys(v.groups), measures: Object.keys(v.measures) }]));
  if (!e) return { error: "unknown_record_type", menu, rows: [] };
  const groupKey = String(q.groupBy ?? Object.keys(e.groups)[0]);
  const measureKey = String(q.measure ?? "count");
  const g = e.groups[groupKey]; const m = e.measures[measureKey];
  if (!g || !m) return { error: "unknown_grouping_or_measure", menu, rows: [] };
  const d = days(q.days, 90);
  const { rows } = await pool.query(
    `SELECT ${g} AS label, ${m} AS value FROM ${e.from} WHERE ${e.where} AND ${e.date} >= now() - ($1 || ' days')::interval GROUP BY 1 ORDER BY ${groupKey === "month" ? "1" : "2 DESC"} LIMIT 50`, [d]);
  return { entity: entityKey, groupBy: groupKey, measure: measureKey, days: d, menu, rows: rows.map((r: any) => ({ label: String(r.label), value: Math.round(Number(r.value) * 100) / 100 })) };
}
