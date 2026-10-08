// BF_SERVER_REPORTS6_10_v780 - pipeline movement, average deal size, goals, meetings, tasks. Boreal Financial silo.
import { pool } from "../../db.js";
import type { Ctx } from "./data2.js";

function days(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1095) : fallback;
}
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Math.round(Number(v)));
const LOST = `(a.funded_at IS NULL AND (a.status = 'DECLINED' OR COALESCE(a.pipeline_state, '') ILIKE 'reject%' OR COALESCE(a.current_stage, '') ILIKE 'reject%'))`;
const STAFF_NAME = `COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'Unassigned')`;

/** 6. What entered, was submitted, funded or was lost in the window - with amounts. */
export async function pipelineMovement(q: Record<string, unknown>) {
  const d = days(q.days, 30);
  const { rows } = await pool.query(
    `SELECT 'Started' AS label, count(*)::int AS files, COALESCE(sum(requested_amount), 0) AS amount FROM applications a
       WHERE a.silo = 'BF' AND a.created_at >= now() - ($1 || ' days')::interval
     UNION ALL
     SELECT 'Submitted to lenders', count(*)::int, COALESCE(sum(requested_amount), 0) FROM applications a
       WHERE a.silo = 'BF' AND a.submitted_at >= now() - ($1 || ' days')::interval
     UNION ALL
     SELECT 'Funded', count(*)::int, COALESCE(sum(requested_amount), 0) FROM applications a
       WHERE a.silo = 'BF' AND a.funded_at >= now() - ($1 || ' days')::interval
     UNION ALL
     SELECT 'Lost', count(*)::int, COALESCE(sum(requested_amount), 0) FROM applications a
       WHERE a.silo = 'BF' AND ${LOST} AND a.updated_at >= now() - ($1 || ' days')::interval`,
    [d],
  );
  return { days: d, rows: rows.map((r: any) => ({ label: r.label, files: r.files, amount: num(r.amount) })) };
}

/** 7. Average and median requested amount, by product and by lead source. */
export async function averageDealSize(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const shape = (r: any) => ({ label: r.label, files: r.files, average: num(r.average), median: num(r.median), funded_average: r.funded_average === null ? null : num(r.funded_average) });
  const base = `FROM applications a WHERE a.silo = 'BF' AND a.requested_amount > 0 AND a.created_at >= now() - ($1 || ' days')::interval`;
  const cols = `count(*)::int AS files, avg(a.requested_amount) AS average,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY a.requested_amount) AS median,
                avg(a.requested_amount) FILTER (WHERE a.funded_at IS NOT NULL) AS funded_average`;
  const byProduct = (await pool.query(`SELECT COALESCE(NULLIF(a.product_category, ''), 'Other') AS label, ${cols} ${base} GROUP BY 1 ORDER BY 2 DESC`, [d])).rows.map(shape);
  const bySource = (await pool.query(`SELECT COALESCE(NULLIF(a.source, ''), 'Direct') AS label, ${cols} ${base} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, [d])).rows.map(shape);
  return { days: d, byProduct, bySource };
}

/** 8. This month's funding and commission targets per staff member, with progress. Staff see their own. */
export async function goals(_q: Record<string, unknown>, ctx: Ctx) {
  const { rows } = await pool.query(
    `WITH m AS (SELECT date_trunc('month', now())::date AS month),
     done AS (
       SELECT a.owner_user_id AS user_id,
              COALESCE(sum(a.requested_amount) FILTER (WHERE a.funded_at >= (SELECT month FROM m)), 0) AS funded,
              COALESCE(sum(a.commission_received_amount) FILTER (WHERE a.commission_received_at >= (SELECT month FROM m)), 0) AS commission
         FROM applications a WHERE a.silo = 'BF' AND a.owner_user_id IS NOT NULL GROUP BY 1)
     SELECT u.id::text AS user_id, ${STAFF_NAME} AS name, g.funding_target, g.commission_target,
            COALESCE(done.funded, 0) AS funded, COALESCE(done.commission, 0) AS commission
       FROM users u
       LEFT JOIN report_goals g ON g.user_id = u.id AND g.month = (SELECT month FROM m)
       LEFT JOIN done ON done.user_id = u.id
      WHERE COALESCE(u.is_active, true) = true AND u.role IN ('Admin', 'Staff')
        AND ($1::boolean OR u.id::text = $2)
      ORDER BY name`,
    [ctx.role === "Admin", ctx.userId],
  );
  const month = new Date(); month.setUTCDate(1);
  return {
    month: month.toISOString().slice(0, 7),
    canEdit: ctx.role === "Admin",
    rows: rows.map((r: any) => ({ userId: r.user_id, name: r.name, fundingTarget: r.funding_target === null ? null : num(r.funding_target), funded: num(r.funded), commissionTarget: r.commission_target === null ? null : num(r.commission_target), commission: num(r.commission) })),
  };
}

/** 9. Client bookings: booked, held (past and not cancelled), cancelled, upcoming, and how many led to a funded file. */
export async function meetings(q: Record<string, unknown>) {
  const d = days(q.days, 90);
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), b.staff_email) AS label,
            count(*)::int AS booked,
            count(*) FILTER (WHERE b.status <> 'cancelled' AND b.starts_at < now())::int AS held,
            count(*) FILTER (WHERE b.status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE b.status <> 'cancelled' AND b.starts_at >= now())::int AS upcoming,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM applications a WHERE a.contact_id = b.contact_id AND a.funded_at IS NOT NULL AND a.funded_at > b.starts_at))::int AS led_to_funded
       FROM client_bookings b LEFT JOIN users u ON u.id = b.staff_user_id
      WHERE b.created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 2 DESC`,
    [d],
  );
  return { days: d, note: "Held means the time has passed and it was not cancelled; no-shows are not recorded yet.", rows };
}

/** 10. Tasks per person: open, overdue, completed in the window, and completed on time. Staff see their own. */
export async function tasksReport(q: Record<string, unknown>, ctx: Ctx) {
  const d = days(q.days, 30);
  const { rows } = await pool.query(
    `SELECT ${STAFF_NAME} AS label,
            count(*) FILTER (WHERE t.completed_at IS NULL)::int AS open,
            count(*) FILTER (WHERE t.completed_at IS NULL AND t.due_at < now())::int AS overdue,
            count(*) FILTER (WHERE t.completed_at >= now() - ($1 || ' days')::interval)::int AS completed,
            count(*) FILTER (WHERE t.completed_at >= now() - ($1 || ' days')::interval AND (t.due_at IS NULL OR t.completed_at <= t.due_at))::int AS on_time
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id
      WHERE t.deleted_at IS NULL AND COALESCE(t.silo, 'BF') = 'BF'
        AND ($2::boolean OR t.assignee_user_id::text = $3)
      GROUP BY 1 ORDER BY 3 DESC, 2 DESC`,
    [d, ctx.role === "Admin", ctx.userId],
  );
  return { days: d, rows };
}
