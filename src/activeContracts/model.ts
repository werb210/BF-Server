// BF_SERVER_v864_ACTIVE_CONTRACTS - the pure rules of Active Contracts: statuses, renewal rules, balance estimate,
// renewal engine decisions and revenue maths. Nothing here touches the database.

export const STATUSES = [
  "active", "renewal_upcoming", "renewal_eligible", "renewal_in_progress",
  "refinanced", "paid_out", "matured", "closed", "default",
] as const;
export type ContractStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<ContractStatus, string> = {
  active: "Active", renewal_upcoming: "Renewal Upcoming", renewal_eligible: "Renewal Eligible",
  renewal_in_progress: "Renewal In Progress", refinanced: "Refinanced", paid_out: "Paid Out", matured: "Matured",
  closed: "Closed", default: "Default / Problem Account",
};
/** Contracts in these statuses are history: kept forever, shown under Completed / Closed. */
export const HISTORY_STATUSES: ReadonlySet<string> = new Set(["refinanced", "paid_out", "matured", "closed"]);
/** The renewal engine may only move a contract between these. It never touches history or Default. */
export const ENGINE_STATUSES: ReadonlySet<string> = new Set(["active", "renewal_upcoming", "renewal_eligible", "renewal_in_progress"]);
export function isStatus(v: unknown): v is ContractStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export const RULE_TYPES = ["percent_paid", "months_before_maturity", "specific_date", "manual", "not_renewable"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export type RenewalRule = {
  rule_type: RuleType;
  percent_threshold?: number | null;
  approach_points?: number | null;
  months_before_maturity?: number | null;
  eligible_after_months?: number | null;
  source?: "contract" | "product" | "default";
};

export const COMMISSION_MODELS = ["upfront", "monthly_recurring", "residual", "revenue_share", "profit_share", "fixed_recurring", "combination", "other"] as const;
export const LEDGER_TYPES = ["funding", "commission_received", "recurring_payment", "profit_share_payment", "adjustment", "clawback",
  "renewal", "refinance", "payoff", "maturity", "closure", "correction"] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];
/** Money Boreal actually received (or gave back). */
export const REVENUE_TYPES: ReadonlySet<string> = new Set(["commission_received", "recurring_payment", "profit_share_payment", "adjustment", "clawback"]);
export const FREQUENCIES = ["daily", "weekly", "biweekly", "semi_monthly", "monthly", "quarterly", "annually", "other"] as const;
const PER_YEAR: Record<string, number> = { daily: 252, weekly: 52, biweekly: 26, semi_monthly: 24, monthly: 12, quarterly: 4, annually: 1 };

const DAY = 86_400_000;
export function toDate(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).length === 10 ? `${v}T00:00:00Z` : String(v));
  return Number.isFinite(d.getTime()) ? d : null;
}
export function isoDay(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
export function addMonths(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY);
}
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "24 months", "24", "2 years", "18 mo" -> months. */
export function parseTermMonths(v: unknown): number | null {
  const s = String(v ?? "").toLowerCase().trim();
  if (!s) return null;
  const n = num(s);
  if (n === null || n <= 0) return null;
  if (/year|yr/.test(s)) return Math.round(n * 12);
  if (/week|wk/.test(s)) return Math.max(1, Math.round(n / 4.345));
  if (/day/.test(s)) return Math.max(1, Math.round(n / 30.4));
  return Math.round(n);
}
/** An offer's rate_factor text: 1.0-2.0 with no % is an MCA factor, anything else an annual rate in %. */
export function parseRate(v: unknown): { interest_rate: number | null; factor_rate: number | null } {
  const s = String(v ?? "").trim();
  const n = num(s);
  if (n === null) return { interest_rate: null, factor_rate: null };
  if (!s.includes("%") && n >= 1 && n < 2) return { interest_rate: null, factor_rate: n };
  return { interest_rate: n, factor_rate: null };
}
export function normFrequency(v: unknown): string | null {
  const s = String(v ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return null;
  if (s.includes("daily") || s === "day") return "daily";
  if (s.includes("biweek") || s.includes("everytwoweeks")) return "biweekly";
  if (s.includes("semimonth") || s.includes("twicemonth")) return "semi_monthly";
  if (s.includes("week")) return "weekly";
  if (s.includes("quarter")) return "quarterly";
  if (s.includes("annual") || s.includes("year")) return "annually";
  if (s.includes("month")) return "monthly";
  return "other";
}

export type ContractLike = {
  id?: string; status?: string | null; product_category?: string | null;
  original_amount?: unknown; funded_at?: unknown; term_months?: unknown; maturity_date?: unknown;
  interest_rate?: unknown; factor_rate?: unknown; payment_amount?: unknown; payment_frequency?: string | null;
  renewal_rule?: unknown; renewal_eligible_on?: unknown; manual_renewal_eligible?: boolean | null;
  end_of_term_date?: unknown;
};
export type ReportedBalance = { balance: unknown; as_of: unknown; source: string; payments_made?: unknown } | null;

export function maturityOf(c: ContractLike): Date | null {
  const m = toDate(c.maturity_date);
  if (m) return m;
  const f = toDate(c.funded_at);
  const t = num(c.term_months);
  return f && t ? addMonths(f, t) : null;
}

/** Payments made by `now` at the contract's frequency. */
export function paymentsElapsed(c: ContractLike, now: Date): number | null {
  const f = toDate(c.funded_at);
  const per = PER_YEAR[String(c.payment_frequency ?? "")];
  if (!f || !per) return null;
  const years = Math.max(0, (now.getTime() - f.getTime()) / (365.25 * DAY));
  return Math.floor(years * per);
}

export type BalanceView = {
  balance: number | null; percent_paid: number | null; basis: "reported" | "estimated" | "unknown";
  source: string; as_of: string | null; total_repayable: number | null;
};

/**
 * The balance shown on a contract. A confirmed lender statement, a lender-portal figure or a manual update wins
 * (labelled with its source and date). Otherwise an estimate from the amortization (always labelled "estimated"):
 *   MCA with a factor rate: repayable = amount x factor, paid = payments made x payment amount.
 *   Loan with a rate: standard amortization (payment computed when not entered).
 *   Otherwise straight-line over the term.
 */
export function balanceView(c: ContractLike, reported: ReportedBalance, now: Date): BalanceView {
  const amount = num(c.original_amount);
  const factor = num(c.factor_rate);
  const repayable = amount !== null && factor ? round2(amount * factor) : amount;
  const pctOf = (bal: number) => (repayable && repayable > 0 ? Math.max(0, Math.min(100, round2(((repayable - bal) / repayable) * 100))) : null);
  if (reported && num(reported.balance) !== null) {
    const bal = num(reported.balance)!;
    return { balance: round2(bal), percent_paid: pctOf(bal), basis: "reported", source: reported.source, as_of: isoDay(toDate(reported.as_of)), total_repayable: repayable };
  }
  const unknown: BalanceView = { balance: null, percent_paid: null, basis: "unknown", source: "none", as_of: null, total_repayable: repayable };
  if (amount === null || amount <= 0) return unknown;
  if (HISTORY_STATUSES.has(String(c.status ?? ""))) {
    return { balance: 0, percent_paid: 100, basis: "estimated", source: "estimated", as_of: isoDay(now), total_repayable: repayable };
  }
  const n = paymentsElapsed(c, now);
  const pmt = num(c.payment_amount);
  const est = (bal: number): BalanceView => {
    const b = round2(Math.max(0, bal));
    return { balance: b, percent_paid: pctOf(b), basis: "estimated", source: "estimated", as_of: isoDay(now), total_repayable: repayable };
  };
  if (factor && repayable) {
    if (n !== null && pmt) return est(repayable - n * pmt);
    return unknown;
  }
  const rate = num(c.interest_rate);
  const term = num(c.term_months);
  const per = PER_YEAR[String(c.payment_frequency ?? "monthly")] ?? 12;
  const elapsed = n ?? (() => {
    const f = toDate(c.funded_at);
    return f ? Math.floor(Math.max(0, now.getTime() - f.getTime()) / (365.25 * DAY) * per) : null;
  })();
  if (elapsed === null) return unknown;
  if (rate && rate > 0) {
    const r = rate / 100 / per;
    const totalPayments = term ? Math.round((term / 12) * per) : null;
    const payment = pmt ?? (totalPayments ? (amount * r) / (1 - Math.pow(1 + r, -totalPayments)) : null);
    if (!payment) return unknown;
    const k = totalPayments ? Math.min(elapsed, totalPayments) : elapsed;
    return est(amount * Math.pow(1 + r, k) - payment * ((Math.pow(1 + r, k) - 1) / r));
  }
  if (term && term > 0) {
    const totalPayments = Math.round((term / 12) * per);
    return est(amount * (1 - Math.min(1, elapsed / totalPayments)));
  }
  return unknown;
}

/** The rule in force: the contract's own override, else the lender product's, else a starting default by product. */
export function effectiveRule(c: ContractLike, productRule: Partial<RenewalRule> | null | undefined): RenewalRule {
  const own = c.renewal_rule && typeof c.renewal_rule === "object" ? (c.renewal_rule as Partial<RenewalRule>) : null;
  if (own?.rule_type && (RULE_TYPES as readonly string[]).includes(own.rule_type)) return { ...own, rule_type: own.rule_type, source: "contract" };
  if (productRule?.rule_type && (RULE_TYPES as readonly string[]).includes(productRule.rule_type)) return { ...productRule, rule_type: productRule.rule_type, source: "product" };
  const cat = String(c.product_category ?? "").toUpperCase();
  if (cat === "MCA") return { rule_type: "percent_paid", percent_threshold: 50, approach_points: 10, source: "default" };
  if (["LOC", "FACTORING", "ABL", "PO", "MEDIA"].includes(cat) || !maturityOf(c)) return { rule_type: "manual", source: "default" };
  return { rule_type: "months_before_maturity", months_before_maturity: 3, source: "default" };
}

export function describeRule(r: RenewalRule): string {
  switch (r.rule_type) {
    case "percent_paid": return `Eligible after ${num(r.percent_threshold) ?? 50}% repaid`;
    case "months_before_maturity": return `Eligible ${num(r.months_before_maturity) ?? 3} months before maturity`;
    case "specific_date": return "Eligible on a set date";
    case "manual": return "Staff decide when it is eligible";
    default: return "Not renewable";
  }
}

export type Evaluation = {
  eligibility: "not_renewable" | "manual" | "not_yet" | "upcoming" | "eligible";
  eligible_on: string | null;
  days_to_maturity: number | null;
  maturity_milestone: "d120" | "d90" | "d60" | "d30" | "matured" | null;
  end_of_term_milestone: "eot90" | "eot30" | null;
  suggested_status: ContractStatus | null;
};

/** What the renewal engine should do with one contract today. */
export function evaluate(c: ContractLike, rule: RenewalRule, bal: BalanceView, now: Date): Evaluation {
  const maturity = maturityOf(c);
  const dtm = maturity ? daysBetween(now, maturity) : null;
  let eligibility: Evaluation["eligibility"] = "not_yet";
  let eligibleOn: Date | null = null;
  if (rule.rule_type === "not_renewable") eligibility = "not_renewable";
  else if (rule.rule_type === "manual") eligibility = c.manual_renewal_eligible ? "eligible" : "manual";
  else if (rule.rule_type === "percent_paid") {
    const threshold = num(rule.percent_threshold) ?? 50;
    const approach = num(rule.approach_points) ?? 10;
    const pct = bal.percent_paid;
    if (pct !== null && pct >= threshold) eligibility = "eligible";
    else if (pct !== null && pct >= threshold - approach) eligibility = "upcoming";
    const f = toDate(c.funded_at);
    if (pct !== null && pct > 0 && f) {
      const elapsed = Math.max(1, now.getTime() - f.getTime());
      eligibleOn = new Date(f.getTime() + (elapsed * threshold) / pct);
    }
  } else if (rule.rule_type === "months_before_maturity" && maturity) {
    eligibleOn = addMonths(maturity, -(num(rule.months_before_maturity) ?? 3));
  } else if (rule.rule_type === "specific_date") {
    eligibleOn = toDate(c.renewal_eligible_on) ?? (() => {
      const f = toDate(c.funded_at);
      const m = num(rule.eligible_after_months);
      return f && m ? addMonths(f, m) : null;
    })();
  }
  if (eligibleOn && rule.rule_type !== "percent_paid") {
    const d = daysBetween(now, eligibleOn);
    eligibility = d <= 0 ? "eligible" : d <= 30 ? "upcoming" : "not_yet";
  }
  if (c.manual_renewal_eligible && eligibility !== "not_renewable") eligibility = "eligible";
  let ms: Evaluation["maturity_milestone"] = null;
  if (dtm !== null) ms = dtm <= 0 ? "matured" : dtm <= 30 ? "d30" : dtm <= 60 ? "d60" : dtm <= 90 ? "d90" : dtm <= 120 ? "d120" : null;
  const eot = toDate(c.end_of_term_date);
  const dEot = eot ? daysBetween(now, eot) : null;
  const eotMs: Evaluation["end_of_term_milestone"] = dEot === null || dEot < 0 ? null : dEot <= 30 ? "eot30" : dEot <= 90 ? "eot90" : null;
  let suggested: ContractStatus | null = null;
  if (ENGINE_STATUSES.has(String(c.status ?? "active")) && c.status !== "renewal_in_progress") {
    if (eligibility === "eligible") suggested = "renewal_eligible";
    else if (eligibility === "upcoming" || (eligibility !== "not_renewable" && ms !== null && ms !== "matured")) suggested = "renewal_upcoming";
    else suggested = "active";
  }
  return { eligibility, eligible_on: isoDay(eligibleOn), days_to_maturity: dtm, maturity_milestone: ms, end_of_term_milestone: eotMs, suggested_status: suggested };
}

/** Milestones in order: only the latest one that applies fires; earlier ones are recorded as skipped. */
export const MATURITY_ORDER = ["d120", "d90", "d60", "d30", "matured"] as const;

export type LedgerRow = { id?: string; entry_type: string; amount: unknown; is_revenue?: boolean | null; broker_split_amount?: unknown; referral_split_amount?: unknown; effective_on: unknown; expected_payment_id?: string | null };
export type ExpectedRow = { id: string; kind: string; due_on: unknown; expected_amount: unknown; waived?: boolean | null; variance_reviewed_at?: unknown; period_label?: string | null };

export function netOf(e: LedgerRow): number {
  return (num(e.amount) ?? 0) - (num(e.broker_split_amount) ?? 0) - (num(e.referral_split_amount) ?? 0);
}

/** Revenue = confirmed receipts only (ledger revenue rows, corrections included). Expected stays expected. */
export function revenueSummary(ledger: LedgerRow[], expected: ExpectedRow[], now: Date) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let month = 0, ytd = 0, lifetime = 0, gross = 0;
  for (const e of ledger) {
    if (!e.is_revenue) continue;
    const d = toDate(e.effective_on);
    const net = netOf(e);
    lifetime += net;
    gross += num(e.amount) ?? 0;
    if (d && d.getUTCFullYear() === y) {
      ytd += net;
      if (d.getUTCMonth() === m) month += net;
    }
  }
  const today = isoDay(now)!;
  const schedule = expected.map((x) => paymentStatus(x, ledger, today));
  const future = schedule.filter((s) => s.status === "expected" && String(s.due_on) >= today).reduce((t, s) => t + s.expected_amount, 0);
  const nextDue = schedule.filter((s) => s.status === "expected" && String(s.due_on) >= today).sort((a, b) => String(a.due_on).localeCompare(String(b.due_on)))[0] ?? null;
  return {
    current_month: round2(month), ytd: round2(ytd), lifetime: round2(lifetime), lifetime_gross: round2(gross),
    expected_future: round2(future), next_expected: nextDue,
    variances: schedule.filter((s) => s.flagged), schedule,
  };
}

export type PaymentStatus = {
  id: string; kind: string; due_on: string | null; period_label: string | null; expected_amount: number; received: number;
  variance: number; status: "expected" | "received" | "partial" | "over" | "missed" | "waived"; flagged: boolean; reviewed: boolean;
};

export function paymentStatus(x: ExpectedRow, ledger: LedgerRow[], today: string): PaymentStatus {
  const expectedAmount = num(x.expected_amount) ?? 0;
  const received = round2(ledger.filter((e) => e.is_revenue && e.expected_payment_id === x.id).reduce((t, e) => t + (num(e.amount) ?? 0), 0));
  const due = isoDay(toDate(x.due_on));
  const variance = round2(received - expectedAmount);
  let status: PaymentStatus["status"] = "expected";
  if (x.waived) status = "waived";
  else if (received === 0) status = due && due < today ? (daysBetween(toDate(due)!, toDate(today)!) > 15 ? "missed" : "expected") : "expected";
  else if (Math.abs(variance) < 0.005) status = "received";
  else status = variance < 0 ? "partial" : "over";
  const reviewed = Boolean(x.variance_reviewed_at);
  const flagged = !reviewed && (status === "partial" || status === "over" || status === "missed");
  return { id: x.id, kind: x.kind, due_on: due, period_label: x.period_label ?? null, expected_amount: round2(expectedAmount), received, variance, status, flagged, reviewed };
}

/** An expected-payment schedule for recurring models: one row per month from `from` for `months` months. */
export function monthlySchedule(from: Date, months: number, amount: number, kind: string): Array<{ due_on: string; period_label: string; expected_amount: number; kind: string }> {
  const out = [];
  for (let i = 0; i < Math.max(0, Math.min(months, 120)); i++) {
    const d = addMonths(from, i);
    out.push({ due_on: isoDay(d)!, period_label: d.toISOString().slice(0, 7), expected_amount: round2(amount), kind });
  }
  return out;
}
