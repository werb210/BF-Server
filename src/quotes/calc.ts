// BF_SERVER_v872_QUOTES - the money on a quote option, worked out the same way every time (ported from KS-server #50).
// Pure: no database.
//
//   interest_rate  an annual rate (12.5 = 12.5%), amortised: equal payments over the term.
//   factor_rate    a factor (1.35): the client repays amount x factor in equal payments (merchant cash advances,
//                  short-term loans).
// Fees are listed one by one; a fee "taken from the funds" lowers what the client receives. Cost of borrowing =
// everything repaid + every fee - the amount. The estimated APR is the yearly rate at which the funds actually
// received grow into the payments (an internal rate of return) - a guide for comparing options, labelled as such.

export const FREQUENCIES = ["daily", "weekly", "biweekly", "semimonthly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
/** Payments a year. Daily = business days. */
export const PER_YEAR: Record<Frequency, number> = { daily: 252, weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
export const FREQUENCY_LABEL: Record<Frequency, string> = { daily: "Daily (business days)", weekly: "Weekly", biweekly: "Every two weeks", semimonthly: "Twice a month", monthly: "Monthly" };

/** A fee on an option. deducted = taken from the funds; taxable = sales tax applies (the per-fee tax tick). */
export type Fee = { label: string; amount: number; deducted: boolean; taxable?: boolean };

export type OptionInput = {
  amount: number;
  term_months: number | null;
  rate_kind: "interest_rate" | "factor_rate";
  rate: number | null;
  payment_frequency: Frequency;
  payment_count?: number | null;
  /** When staff type the lender's own payment, it wins over the calculation. */
  payment_amount?: number | null;
  payment_overridden?: boolean;
  fees: Fee[];
};

// BF_SERVER_v872_QUOTES - sales tax on fees comes from the v865 sales-tax helper (src/brokerTools/salesTax.ts,
// feeTaxFor): given the fees, it returns the tax lines for the fees ticked taxable, at the quote province's rate.
// Interest and factor cost are financial services and are never taxed; only fees go through it. With no province
// (NO_FEE_TAX) there is no tax and every total is unchanged.
export type TaxLine = { label: string; amount: number };
export type FeeTax = (fees: Fee[]) => TaxLine[];
export const NO_FEE_TAX: FeeTax = () => [];

export type OptionMath = {
  payment_count: number | null;
  payment_amount: number | null;
  total_fees: number;
  total_repayment: number | null;
  cost_of_borrowing: number | null;
  net_proceeds: number;
  estimated_apr: number | null;
  /** Tax on the taxable fees; empty and 0 without a province. Included in total_fees. */
  tax_lines: TaxLine[];
  total_tax: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function paymentCount(termMonths: number | null, f: Frequency): number | null {
  if (!termMonths || !(termMonths > 0)) return null;
  return Math.max(1, Math.round((termMonths * PER_YEAR[f]) / 12));
}

/** Equal payment for an amortised loan; a 0% rate is the amount split evenly. */
export function amortisedPayment(amount: number, annualPct: number, n: number, perYear: number): number {
  const r = annualPct / 100 / perYear;
  if (!(r > 0)) return amount / n;
  return (amount * r) / (1 - (1 + r) ** -n);
}

/** Periodic rate i where netReceived = payment x (1 - (1+i)^-n) / i, by bisection. null when it cannot be found. */
export function periodicIrr(netReceived: number, payment: number, n: number): number | null {
  if (!(netReceived > 0) || !(payment > 0) || !(n > 0)) return null;
  if (payment * n <= netReceived) return 0;
  const pv = (i: number) => (i === 0 ? payment * n : (payment * (1 - (1 + i) ** -n)) / i);
  let lo = 0, hi = 1;
  while (pv(hi) > netReceived && hi < 1e6) hi *= 2;
  for (let k = 0; k < 200; k += 1) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > netReceived) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function computeOption(o: OptionInput, feeTax: FeeTax = NO_FEE_TAX): OptionMath {
  const amount = Math.max(0, Number(o.amount) || 0);
  const fees = (o.fees ?? []).filter((f) => Number(f.amount) > 0);
  const taxLines = feeTax(fees).filter((t) => Number(t.amount) > 0).map((t) => ({ label: t.label, amount: r2(Number(t.amount)) }));
  const totalTax = r2(taxLines.reduce((s, t) => s + t.amount, 0));
  const totalFees = r2(fees.reduce((s, f) => s + Number(f.amount), 0) + totalTax);
  const deducted = fees.filter((f) => f.deducted).reduce((s, f) => s + Number(f.amount), 0);
  const net = r2(amount - deducted);
  const n = o.payment_count && o.payment_count > 0 ? Math.round(o.payment_count) : paymentCount(o.term_months, o.payment_frequency);
  let payment: number | null = null;
  let total: number | null = null;
  if (o.payment_overridden && o.payment_amount && o.payment_amount > 0 && n) {
    payment = r2(o.payment_amount);
    total = r2(payment * n);
  } else if (n && o.rate !== null && o.rate !== undefined && Number.isFinite(o.rate)) {
    if (o.rate_kind === "factor_rate") {
      total = r2(amount * Number(o.rate));
      payment = r2(total / n);
    } else {
      payment = r2(amortisedPayment(amount, Number(o.rate), n, PER_YEAR[o.payment_frequency]));
      total = r2(payment * n);
    }
  }
  const cost = total === null ? null : r2(total - amount + totalFees);
  // Fees not taken from the funds are paid by the client up front: they lower what the client really receives too.
  const received = amount - totalFees;
  const i = payment && n ? periodicIrr(received, payment, n) : null;
  const apr = i === null ? null : r2(i * PER_YEAR[o.payment_frequency] * 100);
  return { payment_count: n, payment_amount: payment, total_fees: totalFees, total_repayment: total, cost_of_borrowing: cost, net_proceeds: net, estimated_apr: apr, tax_lines: taxLines, total_tax: totalTax };
}

/** "1.35" / "1.35 factor" -> factor 1.35; "12.5%" / "12.5" -> interest 12.5. null when nothing usable. */
export function parseRate(raw: unknown): { rate_kind: "interest_rate" | "factor_rate"; rate: number } | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (s.includes("%") || /rate|apr|interest/.test(s)) return { rate_kind: "interest_rate", rate: n };
  if (/factor/.test(s) || (n >= 1 && n < 2)) return { rate_kind: "factor_rate", rate: n };
  return { rate_kind: "interest_rate", rate: n };
}

/** "12 months" / "52 weeks" / "2 years" / "18" -> months. */
export function parseTermMonths(raw: unknown): number | null {
  const s = String(raw ?? "").trim().toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  if (/year|yr/.test(s)) return r2(n * 12);
  if (/week|wk/.test(s)) return r2((n * 12) / 52);
  if (/day/.test(s)) return r2((n * 12) / 365);
  return n;
}

export function parseFrequency(raw: unknown): Frequency {
  const s = String(raw ?? "").trim().toLowerCase();
  if (/daily|day/.test(s)) return "daily";
  if (/bi-?weekly|every two weeks|fortnight/.test(s)) return "biweekly";
  if (/semi-?monthly|twice a month/.test(s)) return "semimonthly";
  if (/week/.test(s)) return "weekly";
  return "monthly";
}
