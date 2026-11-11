// BF_SERVER_v942_BROKER_PAY - how brokers are paid (Todd, Nov 11 2026; research in the project doc):
//   - paid on revenue the brokerage has RECEIVED, on a schedule (e.g. received 1st-15th -> paid on the last day of the
//     month; 16th-end -> paid on the 15th of the next month);
//   - the split is on revenue AFTER the referral partner's fee;
//   - a split per broker, higher on deals they found themselves; volume tiers, whole-period or marginal (the brokerage's
//     choice), on revenue or funded volume;
//   - residuals (monthly profit share) keep paying the broker while they work here - it is their book of business;
//   - bonuses (per funded deal, volume or revenue targets), base pay, a draw recovered from commission, a manager
//     override, manual adjustments; a clawback reverses what was paid.
// Everything here is pure (no database) so it can be checked line by line.

export type Schedule = "semi_monthly" | "monthly" | "on_receipt";
export type TierMode = "marginal" | "whole";
export type TierBasis = "revenue" | "funded_volume";
export type Tier = { from: number; pct: number };

export type PaySettings = { schedule: Schedule; tier_basis: TierBasis; tier_mode: TierMode };
export type PayPlan = {
  user_id: string; split_company_pct: number; split_self_pct: number; tiers: Tier[]; residual_share: boolean;
  base_monthly: number; draw_monthly: number; manager_user_id: string | null; override_pct: number; active: boolean; starts_on: string;
};
export type BonusRule = { id: string; name: string; kind: "per_deal" | "volume_target" | "revenue_target"; amount: number; threshold: number | null; active: boolean };

/** One revenue line with what the pay maths needs from its close. */
export type PayLine = {
  id: string; close_id: string; application_id: string; business: string | null; kind: string; status: string;
  received_amount: number | null; received_on: string | null; clawed_back_on: string | null;
  broker_user_id: string | null; lead_source: "self" | "company";
  /** referral fee owed / inbound expected on the same close (0..1): the broker is split on what is left. */
  referral_ratio: number;
};
export type PayClose = { id: string; application_id: string; business: string | null; broker_user_id: string | null; closed_on: string; funded_amount: number };
export type Adjustment = { user_id: string; pay_date: string; amount: number; reason: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ymd = (s: string) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return { y: y!, m: m!, d: d! }; };
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const at = (y: number, m: number, d: number) => iso(new Date(Date.UTC(y, m - 1, d)));

/** The day money received on `received` is paid to the broker. */
export function payDateFor(received: string, schedule: Schedule): string {
  const { y, m, d } = ymd(received);
  if (schedule === "on_receipt") return at(y, m, d);
  if (schedule === "monthly") return m === 12 ? at(y + 1, 1, 15) : at(y, m + 1, 15);
  if (d <= 15) return at(y, m, lastDay(y, m));
  return m === 12 ? at(y + 1, 1, 15) : at(y, m + 1, 15);
}

/** The days whose receipts are paid on `payDate`, inclusive. */
export function windowFor(payDate: string, schedule: Schedule): { from: string; to: string } {
  const { y, m, d } = ymd(payDate);
  if (schedule === "on_receipt") return { from: payDate, to: payDate };
  const pm = m === 1 ? 12 : m - 1, py = m === 1 ? y - 1 : y;
  if (schedule === "monthly") return { from: at(py, pm, 1), to: at(py, pm, lastDay(py, pm)) };
  if (d === 15) return { from: at(py, pm, 16), to: at(py, pm, lastDay(py, pm)) };
  return { from: at(y, m, 1), to: at(y, m, 15) };
}

/** The pay dates from `from` up to and including `to`. */
export function payDatesBetween(from: string, to: string, schedule: Schedule): string[] {
  if (schedule === "on_receipt") return [];
  const out: string[] = [];
  let { y, m } = ymd(from);
  for (let i = 0; i < 400; i++) {
    const days = schedule === "semi_monthly" ? [15, lastDay(y, m)] : [15];
    for (const d of days) { const s = at(y, m, d); if (s >= from.slice(0, 10) && s <= to.slice(0, 10)) out.push(s); }
    if (at(y, m, 1) > to) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** The split % for a period, from the plan's tiers (or its flat split). Marginal tiers apply per bracket. */
export function commissionOn(net: number, plan: PayPlan, settings: PaySettings, tierMeasure: number): { pctOrBlend: number; amount: number } {
  const tiers = [...(plan.tiers ?? [])].filter((t) => Number.isFinite(t.from) && Number.isFinite(t.pct)).sort((a, b) => a.from - b.from);
  if (!tiers.length) return { pctOrBlend: plan.split_company_pct, amount: r2(net * plan.split_company_pct / 100) };
  if (settings.tier_mode === "whole" || settings.tier_basis === "funded_volume") {
    // A volume tier sets one rate for the period; "whole" does the same on revenue.
    const t = tiers.filter((x) => tierMeasure >= x.from).pop() ?? tiers[0]!;
    return { pctOrBlend: t.pct, amount: r2(net * t.pct / 100) };
  }
  let amount = 0;
  for (let i = 0; i < tiers.length; i++) {
    const lo = tiers[i]!.from, hi = i + 1 < tiers.length ? tiers[i + 1]!.from : Infinity;
    const slice = Math.max(0, Math.min(net, hi) - lo);
    amount += slice * tiers[i]!.pct / 100;
  }
  return { pctOrBlend: net > 0 ? r2(amount / net * 100) : tiers[0]!.pct, amount: r2(amount) };
}

export type StatementLine = { kind: "commission" | "residual" | "clawback" | "bonus" | "base" | "draw" | "draw_recovered" | "override" | "adjustment"; text: string; amount: number; application_id?: string };
export type Statement = {
  user_id: string; pay_date: string; window: { from: string; to: string };
  net_revenue: number; funded_volume: number; deals: number; rate_pct: number;
  lines: StatementLine[]; total: number; draw_balance_after: number;
};

export function buildStatement(input: {
  userId: string; payDate: string; settings: PaySettings; plan: PayPlan | null; plans: PayPlan[];
  lines: PayLine[]; closes: PayClose[]; bonuses: BonusRule[]; adjustments: Adjustment[]; drawBalanceBefore: number;
}): Statement {
  const { userId, payDate, settings, plan } = input;
  const window = windowFor(payDate, settings.schedule);
  const inWindow = (d: string | null) => !!d && d.slice(0, 10) >= window.from && d.slice(0, 10) <= window.to;
  const out: StatementLine[] = [];
  const empty: Statement = { user_id: userId, pay_date: payDate, window, net_revenue: 0, funded_volume: 0, deals: 0, rate_pct: 0, lines: [], total: 0, draw_balance_after: input.drawBalanceBefore };
  if (!plan || !plan.active || payDate < plan.starts_on) return empty;

  const mine = input.lines.filter((l) => l.broker_user_id === userId && l.kind !== "referral_fee" && (plan.residual_share || l.kind !== "residual"));
  const received = mine.filter((l) => l.received_amount && (l.status === "received" || l.status === "clawed_back") && inWindow(l.received_on));
  const clawed = mine.filter((l) => l.status === "clawed_back" && l.received_amount && inWindow(l.clawed_back_on));
  const net = (l: PayLine) => r2((l.received_amount ?? 0) * (1 - Math.min(1, Math.max(0, l.referral_ratio))));
  const netRevenue = r2(received.reduce((a, l) => a + net(l), 0));
  const myCloses = input.closes.filter((c) => c.broker_user_id === userId && inWindow(c.closed_on));
  const fundedVolume = r2(myCloses.reduce((a, c) => a + c.funded_amount, 0));

  const tierMeasure = settings.tier_basis === "funded_volume" ? fundedVolume : netRevenue;
  const { pctOrBlend } = commissionOn(netRevenue, plan, settings, tierMeasure);
  const selfBump = Math.max(0, plan.split_self_pct - plan.split_company_pct);
  let commission = 0;
  for (const l of received) {
    const pct = pctOrBlend + (l.lead_source === "self" ? selfBump : 0);
    const amt = r2(net(l) * pct / 100);
    commission += amt;
    out.push({ kind: l.kind === "residual" ? "residual" : "commission", text: `${l.business ?? "Deal"} - ${label(l.kind)} ${money(net(l))} at ${r2(pct)}%`, amount: amt, application_id: l.application_id });
  }
  for (const l of clawed) {
    const pct = pctOrBlend + (l.lead_source === "self" ? selfBump : 0);
    const amt = -r2(net(l) * pct / 100);
    commission += amt;
    out.push({ kind: "clawback", text: `${l.business ?? "Deal"} - ${label(l.kind)} clawed back`, amount: amt, application_id: l.application_id });
  }

  // Draw: advanced each period and recovered from commission (never from base pay or bonuses).
  const fraction = settings.schedule === "semi_monthly" ? 0.5 : settings.schedule === "monthly" ? 1 : 0;
  let drawBalance = input.drawBalanceBefore;
  const recover = Math.max(0, Math.min(drawBalance, commission));
  if (recover > 0) { drawBalance = r2(drawBalance - recover); out.push({ kind: "draw_recovered", text: "Draw recovered from commission", amount: -r2(recover) }); }
  if (plan.draw_monthly > 0 && fraction > 0) {
    const adv = r2(plan.draw_monthly * fraction);
    drawBalance = r2(drawBalance + adv);
    out.push({ kind: "draw", text: "Draw (advance on commission)", amount: adv });
  }
  if (plan.base_monthly > 0 && fraction > 0) out.push({ kind: "base", text: "Base pay", amount: r2(plan.base_monthly * fraction) });

  for (const b of input.bonuses.filter((x) => x.active)) {
    if (b.kind === "per_deal" && myCloses.length) out.push({ kind: "bonus", text: `${b.name}: ${myCloses.length} funded deal${myCloses.length === 1 ? "" : "s"}`, amount: r2(b.amount * myCloses.length) });
    if (b.kind === "volume_target" && b.threshold != null && fundedVolume >= b.threshold) out.push({ kind: "bonus", text: `${b.name}: ${money(fundedVolume)} funded`, amount: r2(b.amount) });
    if (b.kind === "revenue_target" && b.threshold != null && netRevenue >= b.threshold) out.push({ kind: "bonus", text: `${b.name}: ${money(netRevenue)} revenue`, amount: r2(b.amount) });
  }

  // Manager override on the brokers this person manages.
  for (const team of input.plans.filter((p) => p.manager_user_id === userId && p.override_pct > 0 && p.active)) {
    const theirs = input.lines.filter((l) => l.broker_user_id === team.user_id && l.kind !== "referral_fee" && l.received_amount && (l.status === "received" || l.status === "clawed_back") && inWindow(l.received_on));
    const base = r2(theirs.reduce((a, l) => a + net(l), 0));
    if (base > 0) out.push({ kind: "override", text: `Override ${team.override_pct}% on a team member's ${money(base)}`, amount: r2(base * team.override_pct / 100) });
  }
  for (const a of input.adjustments.filter((x) => x.user_id === userId && x.pay_date === payDate)) out.push({ kind: "adjustment", text: a.reason, amount: r2(a.amount) });

  return {
    user_id: userId, pay_date: payDate, window, net_revenue: netRevenue, funded_volume: fundedVolume, deals: myCloses.length,
    rate_pct: r2(pctOrBlend), lines: out, total: r2(out.reduce((a, l) => a + l.amount, 0)), draw_balance_after: drawBalance,
  };
}

const LABELS: Record<string, string> = { lender_commission: "lender commission", residual: "profit share", client_fee: "client fee", setup_fee: "set-up fee", proceeds_fee: "fee from proceeds", spread: "rate difference", other: "other revenue" };
export const label = (k: string) => LABELS[k] ?? k;
const money = (n: number) => n.toLocaleString("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
