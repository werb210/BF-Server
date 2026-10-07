// BF_SERVER_REPORTS_BATCH5_v776 - deal velocity, won vs lost, call outcomes, client reply time,
// commission receivable. All Boreal Financial silo.
import { pool } from "../../db.js";
import type { Ctx } from "./data2.js";

function days(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1095) : fallback;
}
const r1 = (v: unknown): number | null => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);

/** Median days from start to submitted, to first offer, and to funded, for files funded in the window. */
export async function dealVelocity(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const { rows } = await pool.query(
    `WITH f AS (
       SELECT COALESCE(NULLIF(a.product_category, ''), 'Other') AS product, a.created_at, a.submitted_at, a.funded_at,
              (SELECT min(o.created_at) FROM offers o WHERE o.application_id = a.id::text) AS first_offer
         FROM applications a
        WHERE a.silo = 'BF' AND a.funded_at IS NOT NULL AND a.funded_at >= now() - ($1 || ' days')::interval)
     SELECT product, count(*)::int AS funded,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (submitted_at - created_at::timestamptz)) / 86400) AS to_submit,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_offer - submitted_at)) / 86400) AS to_offer,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (funded_at - COALESCE(first_offer, submitted_at))) / 86400) AS offer_to_funded,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (funded_at - created_at::timestamptz)) / 86400) AS total
       FROM f GROUP BY ROLLUP (product) ORDER BY (product IS NULL), funded DESC`,
    [d],
  );
  return { days: d, rows: rows.map((r: any) => ({ product: r.product ?? "All products", funded: r.funded, to_submit: r1(r.to_submit), to_offer: r1(r.to_offer), offer_to_funded: r1(r.offer_to_funded), total: r1(r.total) })) };
}

/** Of files submitted in the window: funded, lost, still open - by month and by product. */
export async function winRate(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const lost = `(a.funded_at IS NULL AND (a.status = 'DECLINED' OR COALESCE(a.pipeline_state, '') ILIKE 'reject%' OR COALESCE(a.current_stage, '') ILIKE 'reject%' OR a.rejection_email_sent_at IS NOT NULL))`;
  const base = `FROM applications a WHERE a.silo = 'BF' AND a.submitted_at IS NOT NULL AND a.submitted_at >= now() - ($1 || ' days')::interval`;
  const cols = `count(*)::int AS submitted, count(*) FILTER (WHERE a.funded_at IS NOT NULL)::int AS funded, count(*) FILTER (WHERE ${lost})::int AS lost`;
  const byMonth = (await pool.query(`SELECT to_char(date_trunc('month', a.submitted_at), 'YYYY-MM') AS label, ${cols} ${base} GROUP BY 1 ORDER BY 1`, [d])).rows;
  const byProduct = (await pool.query(`SELECT COALESCE(NULLIF(a.product_category, ''), 'Other') AS label, ${cols} ${base} GROUP BY 1 ORDER BY 2 DESC`, [d])).rows;
  const shape = (r: any) => ({ label: r.label, submitted: r.submitted, funded: r.funded, lost: r.lost, open: r.submitted - r.funded - r.lost,
    win_rate: r.funded + r.lost > 0 ? Math.round((r.funded / (r.funded + r.lost)) * 100) : null });
  return { days: d, months: byMonth.map(shape), products: byProduct.map(shape) };
}

/** Calls by result, per person (Staff see their own). */
export async function callOutcomes(q: Record<string, unknown>, ctx: Ctx) {
  const d = days(q.days, 30);
  const own = ctx.role === "Staff";
  const { rows } = await pool.query(
    `SELECT COALESCE(NULLIF(trim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''), u.email, 'Unassigned') AS staff,
            CASE WHEN NULLIF(c.disposition, '') IS NOT NULL THEN replace(c.disposition, '_', ' ')
                 WHEN COALESCE(c.answered, false) OR COALESCE(c.duration_seconds, c.duration, 0) > 0 THEN 'connected (no result saved)'
                 ELSE 'no answer' END AS outcome,
            count(*)::int AS calls
       FROM call_logs c LEFT JOIN users u ON u.id = c.staff_user_id
      WHERE c.created_at >= now() - ($1 || ' days')::interval AND c.direction ILIKE 'out%'
        AND ($2::text IS NULL OR c.staff_user_id::text = $2)
      GROUP BY 1, 2 ORDER BY 1, 3 DESC`,
    [d, own ? ctx.userId : null],
  );
  return { days: d, own, rows };
}

/** How fast staff answer clients (texts, portal chat, email), and who is waiting right now. */
export async function clientReplyTime(q: Record<string, unknown>) {
  const d = days(q.days, 30);
  const { rows } = await pool.query(
    `WITH m AS (
       SELECT id, contact_id, direction, COALESCE(NULLIF(channel, ''), NULLIF(type, ''), 'other') AS channel, created_at,
              LAG(direction) OVER (PARTITION BY contact_id ORDER BY created_at) AS prev_dir
         FROM communications_messages
        WHERE contact_id IS NOT NULL AND direction IN ('inbound', 'outbound') AND COALESCE(silo, 'BF') = 'BF'
          AND created_at >= now() - ($1 || ' days')::interval - interval '30 days'),
     t AS (
       SELECT m.*, r.created_at AS replied_at, r.staff_name
         FROM m LEFT JOIN LATERAL (
           SELECT o.created_at, o.staff_name FROM communications_messages o
            WHERE o.contact_id = m.contact_id AND o.direction = 'outbound' AND o.created_at > m.created_at
            ORDER BY o.created_at LIMIT 1) r ON true
        WHERE m.direction = 'inbound' AND m.prev_dir IS DISTINCT FROM 'inbound' AND m.created_at >= now() - ($1 || ' days')::interval)
     SELECT channel, count(*)::int AS messages, count(replied_at)::int AS answered,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (replied_at - created_at)) / 60) AS median_minutes
       FROM t GROUP BY 1 ORDER BY 2 DESC`,
    [d],
  );
  const waiting = (await pool.query(
    `SELECT l.contact_id::text AS contact_id, COALESCE(NULLIF(c.name, ''), NULLIF(trim(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), c.phone, 'Unknown') AS name,
            l.channel, l.created_at, round(EXTRACT(EPOCH FROM (now() - l.created_at)) / 60)::int AS minutes_waiting
       FROM (SELECT DISTINCT ON (contact_id) contact_id, direction, COALESCE(NULLIF(channel, ''), NULLIF(type, ''), 'other') AS channel, created_at
               FROM communications_messages
              WHERE contact_id IS NOT NULL AND direction IN ('inbound', 'outbound') AND COALESCE(silo, 'BF') = 'BF' AND created_at >= now() - interval '14 days'
              ORDER BY contact_id, created_at DESC) l
       LEFT JOIN contacts c ON c.id = l.contact_id
      WHERE l.direction = 'inbound'
      ORDER BY l.created_at ASC LIMIT 25`,
  )).rows;
  return { days: d, channels: rows.map((r: any) => ({ channel: r.channel, messages: r.messages, answered: r.answered, median_minutes: r.median_minutes === null ? null : Math.round(Number(r.median_minutes)) })), waiting };
}

/** Commission owed to Boreal by lenders on funded files, by how long since funding. */
export async function commissionReceivable() {
  const { rows } = await pool.query(
    `SELECT a.id::text AS application_id, COALESCE(NULLIF(a.business_legal_name, ''), a.name) AS name, l.name AS lender,
            a.funded_at, COALESCE(a.funded_currency, 'CAD') AS currency,
            round(COALESCE(a.funded_amount, a.requested_amount, 0) * COALESCE(lp.commission, 2) / 100.0)::float AS expected,
            a.commission_received_at, a.commission_received_amount::float AS received_amount,
            GREATEST(0, EXTRACT(DAY FROM now() - a.funded_at))::int AS days_since_funded
       FROM applications a
       LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
       LEFT JOIN lenders l ON l.id = a.lender_id
      WHERE a.silo = 'BF' AND a.funded_at IS NOT NULL AND a.funded_at >= now() - interval '2 years'
      ORDER BY (a.commission_received_at IS NULL) DESC, a.funded_at ASC LIMIT 300`,
  );
  const bucket = (dd: number) => (dd <= 30 ? "0-30 days" : dd <= 60 ? "31-60 days" : dd <= 90 ? "61-90 days" : "90+ days");
  const buckets: Record<string, { files: number; expected: number }> = { "0-30 days": { files: 0, expected: 0 }, "31-60 days": { files: 0, expected: 0 }, "61-90 days": { files: 0, expected: 0 }, "90+ days": { files: 0, expected: 0 } };
  for (const r of rows as any[]) if (!r.commission_received_at) { const b = buckets[bucket(r.days_since_funded)]; b.files++; b.expected += Number(r.expected) || 0; }
  return { items: rows, buckets: Object.entries(buckets).map(([age, v]) => ({ age, ...v })), outstanding: (rows as any[]).filter((r) => !r.commission_received_at).length };
}
