// BF_SERVER_v864_ACTIVE_CONTRACTS - summaries, re-engagement queues and the Admin portfolio report.
// Balances and renewal dates are computed by the same rules as the contract card (model.ts), so every number on a
// queue matches the card it opens.
import { daysBetween, HISTORY_STATUSES, num, revenueSummary, toDate } from "./model.js";
import { contractView, expectedFor, ledgerFor, listContracts, type Q } from "./repo.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => round2(xs.reduce((t, x) => t + x, 0));

export type View = ReturnType<typeof contractView>;

function within(dateIso: string | null, now: Date, days: number): boolean {
  const d = toDate(dateIso);
  if (!d) return false;
  const n = daysBetween(now, d);
  return n > 0 && n <= days;
}

/** The company (or contact) header: totals, exposure, renewal counts, revenue, product mix, follow-up counts. */
export function summarize(views: View[], ledger: any[], expected: any[], now: Date, lastContactAt: Date | null = null) {
  const open = views.filter((v) => !v.is_history);
  const rev = revenueSummary(ledger, expected, now);
  const byProduct = new Map<string, number>();
  for (const v of open) byProduct.set(String(v.product_category ?? "OTHER"), (byProduct.get(String(v.product_category ?? "OTHER")) ?? 0) + (v.original_amount ?? 0));
  const totalOpen = sum(open.map((v) => v.original_amount ?? 0));
  const eligible = open.filter((v) => v.renewal.eligibility === "eligible");
  const noContactDays = lastContactAt ? daysBetween(lastContactAt, now) : null;
  return {
    total_original_financing: sum(views.map((v) => v.original_amount ?? 0)),
    open_original_financing: totalOpen,
    estimated_outstanding: sum(open.map((v) => v.balance.balance ?? 0)),
    outstanding_has_estimates: open.some((v) => v.balance.basis !== "reported"),
    active_facilities: open.length,
    renewal_eligible: eligible.length,
    renewals_next_90_days: open.filter((v) => (v.renewal.days_to_maturity !== null && v.renewal.days_to_maturity > 0 && v.renewal.days_to_maturity <= 90) || within(v.renewal.eligible_on, now, 90)).length,
    revenue_current_month: rev.current_month, revenue_ytd: rev.ytd, revenue_lifetime: rev.lifetime, expected_future_revenue: rev.expected_future,
    follow_up: {
      due_now: eligible.length + open.filter((v) => v.outcome_required).length,
      next_30: open.filter((v) => within(v.renewal.eligible_on, now, 30) || (v.renewal.days_to_maturity !== null && v.renewal.days_to_maturity > 0 && v.renewal.days_to_maturity <= 30)).length,
      next_60: open.filter((v) => within(v.renewal.eligible_on, now, 60) || (v.renewal.days_to_maturity !== null && v.renewal.days_to_maturity > 0 && v.renewal.days_to_maturity <= 60)).length,
      next_90: open.filter((v) => within(v.renewal.eligible_on, now, 90) || (v.renewal.days_to_maturity !== null && v.renewal.days_to_maturity > 0 && v.renewal.days_to_maturity <= 90)).length,
      approaching_50: open.filter((v) => v.balance.percent_paid !== null && v.balance.percent_paid >= 40 && v.balance.percent_paid < 50).length,
      no_contact_90_days: noContactDays !== null && noContactDays >= 90 ? 1 : 0,
      last_contact_at: lastContactAt ? lastContactAt.toISOString() : null,
    },
    by_product: [...byProduct.entries()].map(([product, amount]) => ({ product, amount: round2(amount), percent: totalOpen ? Math.round((amount / totalOpen) * 100) : 0 })).sort((a, b) => b.amount - a.amount),
    milestones: open.flatMap((v) => {
      const out: Array<{ contract_id: string; title: string; date: string | null; detail: string }> = [];
      if (v.renewal.eligible_on && v.renewal.eligibility !== "eligible") out.push({ contract_id: v.id, title: "Review renewal options", date: v.renewal.eligible_on, detail: `${v.lender_name ?? ""} ${v.product_name ?? ""}`.trim() });
      if (v.maturity_date) out.push({ contract_id: v.id, title: "Maturity", date: v.maturity_date, detail: `${v.lender_name ?? ""} ${v.product_name ?? ""}`.trim() });
      if (v.end_of_term_date) out.push({ contract_id: v.id, title: "End of term", date: v.end_of_term_date, detail: `${v.lender_name ?? ""} ${v.product_name ?? ""}`.trim() });
      return out;
    }).filter((m) => m.date && m.date >= now.toISOString().slice(0, 10)).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 6),
  };
}

/** Last time anyone at the company was contacted (calls, emails, texts, meetings, notes). */
export async function lastContactFor(db: Q, companyIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!companyIds.length) return out;
  const r = await db.query(
    `WITH people AS (SELECT id, company_id FROM contacts WHERE company_id::text = ANY($1::text[]))
     SELECT x.company_id::text AS company_id, max(x.ts) AS last_at FROM (
       SELECT company_id, created_at AS ts FROM crm_call_log WHERE company_id::text = ANY($1::text[])
       UNION ALL SELECT company_id, created_at FROM crm_email_log WHERE company_id::text = ANY($1::text[])
       UNION ALL SELECT company_id, created_at FROM crm_notes WHERE company_id::text = ANY($1::text[])
       UNION ALL SELECT p.company_id, l.created_at FROM crm_call_log l JOIN people p ON p.id = l.contact_id
       UNION ALL SELECT p.company_id, l.created_at FROM crm_email_log l JOIN people p ON p.id = l.contact_id
       UNION ALL SELECT p.company_id, m.created_at FROM communications_messages m JOIN people p ON p.id::text = m.contact_id::text
       UNION ALL SELECT p.company_id, e.occurred_at FROM call_events e JOIN people p ON p.id::text = e.contact_id::text
     ) x GROUP BY x.company_id`, [companyIds]);
  for (const row of r.rows) { const d = toDate(row.last_at); if (d) out.set(row.company_id, d); }
  return out;
}

export const QUEUES = {
  eligible_now: "Renewal eligible now",
  eligible_30: "Renewal eligible next 30 days",
  eligible_60: "Renewal eligible next 60 days",
  eligible_90: "Renewal eligible next 90 days",
  maturing_90: "Maturing next 90 days",
  no_contact: "Clients with no contact in X months",
  approaching_50: "Contracts approaching 50% paid",
  paid_out_no_new: "Paid-out clients with no new facility",
  equipment_additional: "Equipment clients that may need additional equipment",
  multiple_facilities: "Clients with multiple existing facilities",
  upcoming_maturities: "Clients with upcoming financing maturities",
  outcome_required: "Maturity outcome required",
  variances: "Commission variances for review",
} as const;
export type QueueKey = keyof typeof QUEUES;

export async function portfolioViews(db: Q, silo: string, now: Date): Promise<View[]> {
  return (await listContracts(db, { silo })).map((r) => contractView(r, now));
}

export async function runQueue(db: Q, silo: string, key: QueueKey, now: Date, opts: { months?: number } = {}): Promise<View[]> {
  const all = await portfolioViews(db, silo, now);
  const open = all.filter((v) => !v.is_history);
  const byCompany = new Map<string, View[]>();
  for (const v of all) if (v.company_id) byCompany.set(v.company_id, [...(byCompany.get(v.company_id) ?? []), v]);
  const dtm = (v: View) => v.renewal.days_to_maturity;
  switch (key) {
    case "eligible_now": return open.filter((v) => v.renewal.eligibility === "eligible");
    case "eligible_30": case "eligible_60": case "eligible_90": {
      const days = Number(key.split("_")[1]);
      return open.filter((v) => v.renewal.eligibility !== "eligible" && v.renewal.eligibility !== "not_renewable" && within(v.renewal.eligible_on, now, days));
    }
    case "maturing_90": return open.filter((v) => dtm(v) !== null && dtm(v)! > 0 && dtm(v)! <= 90);
    case "approaching_50": return open.filter((v) => v.balance.percent_paid !== null && v.balance.percent_paid >= 40 && v.balance.percent_paid < 50);
    case "outcome_required": return all.filter((v) => v.outcome_required);
    case "multiple_facilities": return open.filter((v) => v.company_id && (byCompany.get(v.company_id) ?? []).filter((x) => !x.is_history).length >= 2);
    case "upcoming_maturities": return open.filter((v) => dtm(v) !== null && dtm(v)! > 0 && dtm(v)! <= 180);
    case "equipment_additional": return open.filter((v) => String(v.product_category ?? "").toUpperCase() === "EQUIPMENT"
      && ((v.balance.percent_paid ?? 0) >= 50 || (toDate(v.funded_at) ? daysBetween(toDate(v.funded_at)!, now) >= 365 : false)));
    case "paid_out_no_new": {
      const out: View[] = [];
      for (const list of byCompany.values()) {
        if (list.some((v) => !v.is_history)) continue;
        const last = list.filter((v) => v.status === "paid_out" || v.status === "matured" || v.status === "closed").sort((a, b) => String(b.closed_at ?? "").localeCompare(String(a.closed_at ?? "")))[0];
        if (last) out.push(last);
      }
      if (!out.length) return out;
      const recent = await db.query(`SELECT DISTINCT company_id::text AS company_id FROM applications WHERE company_id::text = ANY($1::text[]) AND created_at > now() - interval '180 days' AND COALESCE(source, '') <> 'renewal'`, [out.map((v) => v.company_id)]);
      const busy = new Set(recent.rows.map((r: any) => r.company_id));
      return out.filter((v) => !busy.has(v.company_id));
    }
    case "no_contact": {
      const months = Math.max(1, Math.min(60, Math.floor(opts.months ?? 6)));
      const ids = [...new Set(open.map((v) => v.company_id).filter(Boolean))] as string[];
      const last = await lastContactFor(db, ids);
      return open.filter((v) => {
        const d = v.company_id ? last.get(v.company_id) : null;
        return !d || daysBetween(d, now) >= months * 30;
      }).map((v) => ({ ...v, last_contact_at: v.company_id ? last.get(v.company_id)?.toISOString() ?? null : null }));
    }
    case "variances": {
      const ids = all.map((v) => v.id);
      const rev = new Map<string, any>();
      const ledger = await ledgerFor(db, ids);
      const expected = await expectedFor(db, ids);
      for (const v of all) rev.set(v.id, revenueSummary(ledger.filter((l) => l.contract_id === v.id), expected.filter((e) => e.contract_id === v.id), now));
      return all.filter((v) => rev.get(v.id).variances.length > 0).map((v) => ({ ...v, variances: rev.get(v.id).variances }));
    }
  }
  return [];
}

export async function queueCounts(db: Q, silo: string, now: Date): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(QUEUES) as QueueKey[]) out[key] = (await runQueue(db, silo, key, now)).length;
  return out;
}

/** Section 12: Admin portfolio reporting. */
export async function portfolioReport(db: Q, silo: string, now: Date) {
  const views = await portfolioViews(db, silo, now);
  const ids = views.map((v) => v.id);
  const ledger = await ledgerFor(db, ids);
  const expected = await expectedFor(db, ids);
  const open = views.filter((v) => !v.is_history);
  const byId = new Map(views.map((v) => [v.id, v]));
  const group = (keyOf: (v: View) => string) => {
    const m = new Map<string, number>();
    for (const l of ledger) {
      if (!l.is_revenue) continue;
      const v = byId.get(l.contract_id);
      if (!v) continue;
      const k = keyOf(v) || "Unknown";
      m.set(k, (m.get(k) ?? 0) + (num(l.amount) ?? 0) - (num(l.broker_split_amount) ?? 0) - (num(l.referral_split_amount) ?? 0));
    }
    return [...m.entries()].map(([name, revenue]) => ({ name, revenue: round2(revenue) })).sort((a, b) => b.revenue - a.revenue);
  };
  const companies = new Set(views.map((v) => v.company_id).filter(Boolean));
  const firstByCompany = new Map<string, string>();
  for (const v of [...views].sort((a, b) => String(a.funded_at).localeCompare(String(b.funded_at)))) if (v.company_id && !firstByCompany.has(v.company_id)) firstByCompany.set(v.company_id, v.id);
  const opps = (await db.query(`SELECT status FROM active_contract_opportunities WHERE silo = $1`, [silo])).rows;
  const won = opps.filter((o: any) => o.status === "funded").length;
  const decided = opps.filter((o: any) => ["funded", "lost", "not_interested"].includes(o.status)).length;
  const typeSum = (t: string) => sum(ledger.filter((l) => l.is_revenue && l.entry_type === t).map((l) => num(l.amount) ?? 0));
  const today = now.toISOString().slice(0, 10);
  const rev = revenueSummary(ledger, expected, now);
  const dueSoFar = rev.schedule.filter((s) => s.due_on && s.due_on <= today && s.status !== "waived");
  const within = (n: number) => open.filter((v) => (v.renewal.days_to_maturity !== null && v.renewal.days_to_maturity > 0 && v.renewal.days_to_maturity <= n)).length;
  return {
    active_contracts: open.length,
    total_original_funded: sum(views.map((v) => v.original_amount ?? 0)),
    estimated_outstanding: sum(open.map((v) => v.balance.balance ?? 0)),
    renewals_due: { d30: within(30), d60: within(60), d90: within(90) },
    renewal_conversion_rate: decided ? Math.round((won / decided) * 100) : null,
    repeat_client_volume: sum(views.filter((v) => v.company_id && firstByCompany.get(v.company_id) !== v.id).map((v) => v.original_amount ?? 0)),
    average_contracts_per_customer: companies.size ? round2(views.filter((v) => v.company_id).length / companies.size) : 0,
    renewal_refinance_volume: sum(views.filter((v) => v.previous_contract_id || v.renewal_opportunity_id).map((v) => v.original_amount ?? 0)),
    revenue_by_lender: group((v) => v.lender_name ?? ""),
    revenue_by_product: group((v) => v.product_category ?? ""),
    upfront_commissions: typeSum("commission_received"),
    recurring_commissions: typeSum("recurring_payment"),
    profit_share_revenue: typeSum("profit_share_payment"),
    expected_vs_received: { expected: sum(dueSoFar.map((s) => s.expected_amount)), received: sum(dueSoFar.map((s) => s.received)) },
    commission_variances: { count: rev.variances.length, amount: sum(rev.variances.map((s) => s.variance)) },
    lifetime_value_by_client: group((v) => v.company_name ?? "").slice(0, 25),
    lifetime_value_by_lender: group((v) => v.lender_name ?? ""),
    lifetime_value_by_product: group((v) => v.product_category ?? ""),
    history_contracts: views.filter((v) => HISTORY_STATUSES.has(v.status)).length,
  };
}
