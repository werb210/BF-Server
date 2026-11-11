// BF_SERVER_v940_LENDER_PRODUCT_RULES - a lender product's knock-out rules and commission terms (Todd, Nov 11 2026):
// "if a lender product says 2-3 NSF a month and the client has 4 NSF average per month that is not a lender who should
// see that file", "in CDN under 10k a month is a no go", and lenders fund up to a multiple of average monthly revenue.
// A rule with no value is not checked; a rule whose file figure is not known yet (no banking analysis) is not failed.

export type MatchRules = {
  max_nsf_per_month?: number | null;
  min_monthly_revenue?: number | null;
  max_funding_multiple?: number | null;
  min_avg_daily_balance?: number | null;
  max_positions?: number | null;
  min_months_in_business?: number | null;
};
export type CommissionKind = "flat" | "percent" | "profit_share";
export type CommissionTerms = {
  kind?: CommissionKind | null; amount?: number | null; percent?: number | null;
  share_percent?: number | null; share_months?: number | null; clawback_days?: number | null;
};

/** What we know about the file that the rules are checked against. */
export type FileFigures = {
  monthlyRevenue: number | null;
  monthlyRevenueBasis: "bank deposits" | "application" | "annual revenue / 12" | null;
  nsfPerMonth: number | null;
  avgDailyBalance: number | null;
  positions: number | null;
  monthsInBusiness: number | null;
  requestedAmount: number | null;
};

const RULE_KEYS = ["max_nsf_per_month", "min_monthly_revenue", "max_funding_multiple", "min_avg_daily_balance", "max_positions", "min_months_in_business"] as const;
const WHOLE = new Set(["max_positions", "min_months_in_business", "share_months", "clawback_days"]);
const COMMISSION_KINDS = new Set(["flat", "percent", "profit_share"]);

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Cleans what the product form sends. Returns null when nothing was sent (leave the column alone). */
export function parseMatchRules(raw: unknown): MatchRules | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: MatchRules = {};
  for (const k of RULE_KEYS) {
    const v = num(r[k] ?? r[camel(k)]);
    if (v !== null) out[k] = WHOLE.has(k) ? Math.round(v) : v;
  }
  return out;
}

export function parseCommissionTerms(raw: unknown): CommissionTerms | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" && COMMISSION_KINDS.has(r.kind) ? (r.kind as CommissionKind) : null;
  const out: CommissionTerms = { kind };
  for (const k of ["amount", "percent", "share_percent", "share_months", "clawback_days"] as const) {
    const v = num(r[k] ?? r[camel(k)]);
    if (v !== null) (out as Record<string, number>)[k] = WHOLE.has(k) ? Math.round(v) : v;
  }
  return out;
}

const money = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;

/** Every rule the file breaks, in plain words. Empty means the product may see the file. */
export function knockouts(rules: MatchRules | null | undefined, f: FileFigures): string[] {
  const r = rules ?? {};
  const out: string[] = [];
  if (r.max_nsf_per_month != null && f.nsfPerMonth != null && f.nsfPerMonth > r.max_nsf_per_month) {
    out.push(`${f.nsfPerMonth} NSFs a month on average; this lender allows ${r.max_nsf_per_month}`);
  }
  if (r.min_monthly_revenue != null && f.monthlyRevenue != null && f.monthlyRevenue < r.min_monthly_revenue) {
    out.push(`average monthly revenue ${money(f.monthlyRevenue)} (${f.monthlyRevenueBasis}); this lender needs ${money(r.min_monthly_revenue)}`);
  }
  if (r.min_avg_daily_balance != null && f.avgDailyBalance != null && f.avgDailyBalance < r.min_avg_daily_balance) {
    out.push(`average daily balance ${money(f.avgDailyBalance)}; this lender needs ${money(r.min_avg_daily_balance)}`);
  }
  if (r.max_positions != null && f.positions != null && f.positions > r.max_positions) {
    out.push(`${f.positions} other lenders being paid in the bank statements; this lender allows ${r.max_positions}`);
  }
  if (r.min_months_in_business != null && f.monthsInBusiness != null && f.monthsInBusiness < r.min_months_in_business) {
    out.push(`${Math.round(f.monthsInBusiness)} months in business; this lender needs ${r.min_months_in_business}`);
  }
  return out;
}

/** The most this product would fund on the file's revenue, when the lender funds a multiple of monthly revenue. */
export function fundsUpTo(rules: MatchRules | null | undefined, f: FileFigures): number | null {
  const m = rules?.max_funding_multiple;
  if (m == null || m <= 0 || f.monthlyRevenue == null) return null;
  return Math.round(f.monthlyRevenue * m);
}
