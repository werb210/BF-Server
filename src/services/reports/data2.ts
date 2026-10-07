// BF_SERVER_REPORTS_BATCH2_v719 - the next reports for the Reports section.
import { pool } from "../../db.js";

const days = (v: unknown, d: number) => Math.min(Math.max(Number(v) || d, 1), 730);
export type Ctx = { role: "Admin" | "Marketing" | "Staff"; userId: string };

// BF_SERVER_ONE_COMMISSION_v727 - the forecast used a flat 3% of the requested amount,
// counted files on Hold and added US dollars as Canadian, so it never matched the
// Dashboard. It now uses the Dashboard's own rules: 2% unless the lender product
// carries its own commission, the funded or accepted-offer amount when there is one,
// US deals converted at the Bank of Canada rate, Hold/Fraud/Rejected/drafts left out.
// Only the stage odds are added on top.
export const STAGE_ODDS: Record<string, number> = { "Offer": 0.7, "Accepted": 0.85, "Off to Lender": 0.4, "In Review": 0.25, "Additional Steps Required": 0.15, "Documents Required": 0.15, "Received": 0.1 };
export async function revenueForecast() {
  const { DEAL_CURRENCY_SQL, boardScope } = await import("../../routes/dashboard.js");
  const { liveStageFilter } = await import("../../modules/applications/reportingScope.js");
  const { rows } = await pool.query<{ stage: string; files: number; amount_cad: number; commission_cad: number }>(
    `SELECT x.stage, count(*)::int AS files, COALESCE(sum(x.amount * x.fx),0)::float AS amount_cad, COALESCE(sum(x.native * x.fx),0)::float AS commission_cad
       FROM (
         SELECT (CASE WHEN a.pipeline_state IN ('Received','In Review','Documents Required','Additional Steps Required','Off to Lender','Offer','Accepted')
                 THEN a.pipeline_state ELSE 'Received' END) AS stage,
                COALESCE(a.funded_amount, off.amount, a.requested_amount, 0) AS amount,
                COALESCE(a.funded_amount, off.amount, a.requested_amount, 0) * (COALESCE(lp.commission, 2) / 100.0) AS native,
                COALESCE((SELECT to_cad FROM fx_rates WHERE currency = ${DEAL_CURRENCY_SQL}), 1) AS fx
           FROM applications a
           LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
           LEFT JOIN LATERAL (SELECT o.amount FROM offers o WHERE o.application_id = a.id AND o.status = 'accepted' ORDER BY o.updated_at DESC NULLS LAST LIMIT 1) off ON TRUE
          WHERE UPPER(a.silo) = 'BF' AND a.funded_at IS NULL
            AND COALESCE(a.pipeline_state, '') NOT IN ('draft', 'Draft', '', 'Rejected')
            AND ${boardScope("a")}
            ${liveStageFilter("a.pipeline_state")}
       ) x GROUP BY 1`,
  );
  const stages = rows.map((r) => ({ stage: r.stage, files: r.files, amount: Math.round(r.amount_cad), full_commission: Math.round(r.commission_cad), odds: STAGE_ODDS[r.stage] ?? 0, expected_commission: Math.round(r.commission_cad * (STAGE_ODDS[r.stage] ?? 0)) }))
    .sort((a, b) => b.odds - a.odds);
  return { stages, total: stages.reduce((s, r) => s + r.expected_commission, 0), full_total: stages.reduce((s, r) => s + r.full_commission, 0) };
}

export async function mediaFeeAgreements() {
  const { rows } = await pool.query(`SELECT m.application_id, COALESCE(NULLIF(a.business_legal_name,''), a.name) AS name, m.trigger_lender_name AS lender, m.status,
            m.signer_name, m.created_at, a.requested_amount, a.funded_amount, a.funded_at,
            m.signed_manually, m.fee_percent, m.fee_amount
       FROM media_fee_agreements m LEFT JOIN applications a ON a.id::text = m.application_id
      ORDER BY m.created_at DESC LIMIT 200`);
  // BF_SERVER_FEE_MANUAL_SIGN_v775 - a negotiated agreement carries its own fee (a fixed amount, or a percent); otherwise 2%.
  const fee = (r: any) => r.fee_amount !== null && r.fee_amount !== undefined ? Math.round(Number(r.fee_amount))
    : Math.round(Number(r.funded_amount ?? r.requested_amount ?? 0) * (r.fee_percent !== null && r.fee_percent !== undefined ? Number(r.fee_percent) : 2) / 100);
  const label = (r: any) => r.fee_amount !== null && r.fee_amount !== undefined ? "fixed" : r.fee_percent !== null && r.fee_percent !== undefined ? Number(r.fee_percent) + "%" : "2%";
  return { items: rows.map((r: any) => ({ ...r, fee: fee(r), fee_2pct: fee(r), fee_terms: label(r) })), signed: rows.filter((r: any) => r.status === "signed").length, waiting: rows.filter((r: any) => r.status !== "signed").length };
}

export async function payoutsOwed() {
  const { rows } = await pool.query(`SELECT d.application_id, d.broker_name, d.broker_pct, d.payout_amount, d.payout_paid_on, a.funded_amount, a.funded_at,
            COALESCE(NULLIF(a.business_legal_name,''), a.name) AS name
       FROM broker_deal_confirmations d JOIN applications a ON a.id::text = d.application_id
      WHERE a.funded_at IS NOT NULL AND d.status = 'accepted'
      ORDER BY (d.payout_paid_on IS NULL) DESC, a.funded_at DESC LIMIT 200`);
  return { items: rows, unpaid: rows.filter((r: any) => !r.payout_paid_on).length };
}

export async function staffActivity(q: Record<string, unknown>, ctx: Ctx) {
  const d = days(q.days, 7); const own = ctx.role === "Staff";
  const { rows } = await pool.query(`SELECT c.staff_user_id::text AS staff_user_id,
            COALESCE(NULLIF(trim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')),''), u.email, 'Unassigned') AS staff,
            count(*) FILTER (WHERE c.direction ILIKE 'out%')::int AS outbound,
            count(*) FILTER (WHERE c.direction ILIKE 'in%')::int AS inbound,
            count(*) FILTER (WHERE COALESCE(c.answered, false) OR COALESCE(c.duration_seconds, c.duration, 0) > 0)::int AS connected,
            round(COALESCE(sum(COALESCE(c.duration_seconds, c.duration, 0)),0) / 60.0)::int AS talk_minutes
       FROM call_logs c LEFT JOIN users u ON u.id = c.staff_user_id
      WHERE c.created_at >= now() - ($1 || ' days')::interval AND COALESCE(c.silo,'BF') = 'BF'
        AND ($2::boolean = false OR c.staff_user_id::text = $3)
      GROUP BY 1, 2 ORDER BY count(*) DESC`, [d, own, ctx.userId]);
  return { days: d, own, staff: rows };
}

export async function missedCalls(q: Record<string, unknown>) {
  const d = days(q.days, 14);
  const { rows } = await pool.query(`SELECT c.created_at, COALESCE(c.from_number, c.phone_number) AS caller, c.status,
            (SELECT min(o.created_at) FROM call_logs o WHERE o.direction ILIKE 'out%' AND o.created_at > c.created_at
               AND right(regexp_replace(COALESCE(o.to_number, o.phone_number, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace(COALESCE(c.from_number, c.phone_number, ''), '[^0-9]', '', 'g'), 10)) AS called_back_at
       FROM call_logs c
      WHERE c.direction ILIKE 'in%' AND c.created_at >= now() - ($1 || ' days')::interval
        AND COALESCE(c.answered, false) = false AND COALESCE(c.duration_seconds, c.duration, 0) = 0
      ORDER BY c.created_at DESC LIMIT 200`, [d]);
  const items = rows.map((r: any) => ({ ...r, minutes_to_callback: r.called_back_at ? Math.round((new Date(r.called_back_at).getTime() - new Date(r.created_at).getTime()) / 60000) : null }));
  return { days: d, missed: items.length, not_called_back: items.filter((i) => i.minutes_to_callback === null).length, items };
}

export async function monthlyCohorts(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const { rows } = await pool.query(`SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, count(*)::int AS started,
            count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted, count(*) FILTER (WHERE funded_at IS NOT NULL)::int AS funded
       FROM applications WHERE silo = 'BF' AND created_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [d]);
  return { days: d, months: rows };
}

export async function renewalOpportunities() {
  const { rows } = await pool.query(`SELECT a.id::text AS application_id, COALESCE(NULLIF(a.business_legal_name,''), a.name) AS name, a.product_category, a.funded_amount, a.funded_at
       FROM applications a
      WHERE a.silo = 'BF' AND a.funded_at BETWEEN now() - interval '15 months' AND now() - interval '9 months'
      ORDER BY a.funded_at ASC LIMIT 200`);
  return { items: rows };
}

export async function insuranceCrossSell(q: Record<string, unknown>) {
  const d = days(q.days, 365);
  const { rows } = await pool.query<{ funded: number; with_insurance: number }>(`SELECT count(*)::int AS funded, count(*) FILTER (WHERE COALESCE(bi_application_id,'') <> '')::int AS with_insurance
       FROM applications WHERE silo = 'BF' AND funded_at >= now() - ($1 || ' days')::interval`, [d]);
  return { days: d, ...(rows[0] ?? { funded: 0, with_insurance: 0 }) };
}
