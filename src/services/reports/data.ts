// BF_SERVER_REPORTS_SECTION_v714 - data for the reports built in this block.
import { pool } from "../../db.js";

const CLOSED = ["funded", "declined", "closed", "withdrawn", "archived", "lost", "accepted", "rejected", "draft"]; // BF_SERVER_REPORTS_BATCH2_v719: + rejected, draft
const days = (v: unknown, d = 90) => Math.min(Math.max(Number(v) || d, 1), 365);

export async function stuckDeals(threshold = 7) {
  const { rows } = await pool.query(
    `SELECT a.id::text AS application_id, COALESCE(NULLIF(a.business_legal_name,''), a.name, 'Application') AS name,
            a.pipeline_state AS stage, a.requested_amount,
            COALESCE((SELECT max(h.created_at) FROM application_stage_history h WHERE h.application_id = a.id::text AND h.to_stage = a.pipeline_state), a.submitted_at, a.created_at) AS since
       FROM applications a
      WHERE a.silo = 'BF' AND a.submitted_at IS NOT NULL AND a.funded_at IS NULL
        AND lower(COALESCE(a.pipeline_state,'')) <> ALL($1)
      ORDER BY since ASC LIMIT 200`, [CLOSED]);
  const now = Date.now();
  const items = rows.map((r: any) => ({ ...r, days_in_stage: Math.floor((now - new Date(r.since).getTime()) / 86_400_000) }));
  return { threshold, items, stuck: items.filter((i) => i.days_in_stage >= threshold).length };
}

export async function lenderScorecard(windowDays: unknown) {
  const d = days(windowDays, 180);
  const { rows } = await pool.query(
    `WITH s AS (
       SELECT ls.lender_id, ls.application_id, COALESCE(ls.submitted_at, ls.created_at) AS sent_at
         FROM lender_submissions ls WHERE COALESCE(ls.submitted_at, ls.created_at) >= now() - ($1 || ' days')::interval AND ls.lender_id IS NOT NULL
     ), o AS (
       SELECT o.lender_id::text AS lender_id, o.application_id, min(o.created_at) AS offer_at
         FROM offers o WHERE COALESCE(o.is_archived, false) = false AND o.lender_id IS NOT NULL GROUP BY 1, 2
     )
     SELECT s.lender_id, COALESCE(l.name, 'Lender') AS lender, count(DISTINCT s.application_id)::int AS sent,
            count(DISTINCT o.application_id)::int AS offers,
            count(DISTINCT a.id) FILTER (WHERE a.funded_at IS NOT NULL AND a.lender_id::text = s.lender_id)::int AS funded,
            round(avg(EXTRACT(epoch FROM (o.offer_at - s.sent_at)) / 86400) FILTER (WHERE o.offer_at >= s.sent_at)::numeric, 1)::float AS days_to_offer
       FROM s LEFT JOIN lenders l ON l.id::text = s.lender_id
       LEFT JOIN o ON o.lender_id = s.lender_id AND o.application_id = s.application_id
       LEFT JOIN applications a ON a.id::text = s.application_id
      GROUP BY s.lender_id, l.name ORDER BY sent DESC LIMIT 100`, [d]);
  return { days: d, lenders: rows };
}

export async function speedToLead(windowDays: unknown) {
  const d = days(windowDays, 30);
  const { rows } = await pool.query(
    `SELECT a.id::text AS application_id, a.submitted_at, fc.created_at AS first_call_at, fc.staff_user_id::text AS staff_user_id,
            COALESCE(NULLIF(trim(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')), ''), u.email, 'Unassigned') AS staff
       FROM applications a LEFT JOIN LATERAL (
         SELECT c.created_at, c.staff_user_id FROM call_logs c
          WHERE c.direction ILIKE 'out%' AND c.created_at >= a.submitted_at
            AND (c.application_id = a.id::text OR (a.contact_id IS NOT NULL AND (c.contact_id = a.contact_id OR c.crm_contact_id = a.contact_id)))
          ORDER BY c.created_at ASC LIMIT 1
       ) fc ON true LEFT JOIN users u ON u.id = fc.staff_user_id
      WHERE a.silo = 'BF' AND a.submitted_at >= now() - ($1 || ' days')::interval
      ORDER BY a.submitted_at DESC LIMIT 500`, [d]);
  const mins = (r: any) => (r.first_call_at ? Math.round((new Date(r.first_call_at).getTime() - new Date(r.submitted_at).getTime()) / 60000) : null);
  const byStaff = new Map<string, number[]>();
  let notCalled = 0;
  for (const r of rows) {
    const m = mins(r);
    if (m === null) { notCalled += 1; continue; }
    const k = String(r.staff);
    byStaff.set(k, [...(byStaff.get(k) ?? []), m]);
  }
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
  return { days: d, submitted: rows.length, not_called: notCalled,
    staff: [...byStaff.entries()].map(([staff, xs]) => ({ staff, calls: xs.length, median_minutes: median(xs) })).sort((a, b) => b.calls - a.calls) };
}

// BF_SERVER_ONE_COMMISSION_v727 - same commission rule as the Dashboard (2% unless the
// lender product sets its own; US deals converted to Canadian dollars).
export async function commissionByMonth(windowDays: unknown) {
  const d = days(windowDays, 365);
  const { DEAL_CURRENCY_SQL } = await import("../../routes/dashboard.js");
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', a.funded_at), 'YYYY-MM') AS month, count(*)::int AS funded,
            COALESCE(sum(COALESCE(a.funded_amount, a.requested_amount, 0) * COALESCE((SELECT to_cad FROM fx_rates WHERE currency = ${DEAL_CURRENCY_SQL}), 1)), 0)::float AS funded_amount,
            COALESCE(sum(COALESCE(a.funded_amount, a.requested_amount, 0) * (COALESCE(lp.commission, 2) / 100.0) * COALESCE((SELECT to_cad FROM fx_rates WHERE currency = ${DEAL_CURRENCY_SQL}), 1)), 0)::float AS commission
       FROM applications a LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
      WHERE a.silo = 'BF' AND a.funded_at IS NOT NULL AND a.funded_at >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [d],
  );
  return { days: d, months: rows.map((r: any) => ({ ...r, funded_amount: Math.round(r.funded_amount), commission: Math.round(r.commission) })) };
}

// BF_SERVER_REPORTS_BATCH2_v719 - reports get the viewer (role, user id) too.
import * as B2 from "./data2.js";
export const DATA: Record<string, (q: Record<string, unknown>, ctx: B2.Ctx) => Promise<unknown>> = {
  revenue_forecast: () => B2.revenueForecast(),
  best_lender_by_deal_type: async (q) => (await import("./data3.js")).bestLenderByDealType(q), // BF_SERVER_REPORTS_BATCH3_v721
  consent_health: async () => (await import("./data3.js")).consentHealth(),
  decline_reasons: async (q) => (await import("./data3.js")).declineReasons(q), // BF_SERVER_REPORTS_BATCH4_v722
  document_turnaround: async (q) => (await import("./data3.js")).documentTurnaround(q),
  media_fee_agreements: () => B2.mediaFeeAgreements(),
  payouts_owed: () => B2.payoutsOwed(),
  staff_activity: (q, ctx) => B2.staffActivity(q, ctx),
  missed_calls: (q) => B2.missedCalls(q),
  monthly_cohorts: (q) => B2.monthlyCohorts(q),
  renewal_opportunities: () => B2.renewalOpportunities(),
  insurance_cross_sell: (q) => B2.insuranceCrossSell(q),
  stuck_deals: (q) => stuckDeals(Number(q.threshold) || 7),
  lender_scorecard: (q) => lenderScorecard(q.days),
  speed_to_lead: (q) => speedToLead(q.days),
  commission_by_month: (q) => commissionByMonth(q.days),
  // BF_SERVER_REPORTS_BATCH5_v776
  deal_velocity: async (q) => (await import("./data5.js")).dealVelocity(q),
  win_rate: async (q) => (await import("./data5.js")).winRate(q),
  call_outcomes: async (q, ctx) => (await import("./data5.js")).callOutcomes(q, ctx),
  client_reply_time: async (q) => (await import("./data5.js")).clientReplyTime(q),
  commission_receivable: async () => (await import("./data5.js")).commissionReceivable(),
  // BF_SERVER_REPORTS6_10_v780
  pipeline_movement: async (q) => (await import("./data6.js")).pipelineMovement(q),
  average_deal_size: async (q) => (await import("./data6.js")).averageDealSize(q),
  goals: async (q, ctx) => (await import("./data6.js")).goals(q, ctx),
  meetings: async (q) => (await import("./data6.js")).meetings(q),
  tasks_report: async (q, ctx) => (await import("./data6.js")).tasksReport(q, ctx),
  // BF_SERVER_REPORTS11_14_v785
  email_performance: async (q) => (await import("./data7.js")).emailPerformance(q),
  sms_campaign_performance: async (q) => (await import("./data7.js")).smsCampaignPerformance(q),
  website_pages: async (q) => (await import("./data7.js")).websitePages(q),
  lifecycle: async (q) => (await import("./data7.js")).lifecycle(q),
};
