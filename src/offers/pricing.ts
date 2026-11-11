// OFFER_PRICING_v1 - the money on one offer, worked out the same way everywhere (staff Offer tab, client
// app, our term sheet, expected revenue). Every possible revenue is counted:
//   spread     - the client pays our rate, the lender is paid its rate; the difference over the term is ours
//   broker fee, set-up fee, fee from proceeds (taken out of the funds before they reach the client)
//   lender commission - what the lender pays us on funding, when known
// Interest rates are a yearly percentage paid monthly over the term; factor rates (e.g. 1.28) are a total multiple.

export type RateKind = "interest_rate" | "factor_rate";
export type Rate = { kind: RateKind; value: number };

/** "8.5%", "8.5", "12.9% fixed", "1.28", "1.28 factor", "Prime+2.75" -> a rate we can calculate with, or null. */
export function parseRate(text: unknown): Rate | null {
  const s = String(text ?? "").trim().toLowerCase();
  if (!s || /prime|cor|libor|sofr|\+/.test(s)) return null;
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  if (/factor/.test(s)) return { kind: "factor_rate", value: v };
  if (/%/.test(s)) return { kind: "interest_rate", value: v };
  // A bare 1.0-2.0 is a factor; anything else is a percentage.
  return v >= 1 && v < 2 ? { kind: "factor_rate", value: v } : { kind: "interest_rate", value: v };
}

/** "36 months", "3 years", "5 yrs", "18" -> months, or null. */
export function parseTermMonths(text: unknown): number | null {
  const s = String(text ?? "").trim().toLowerCase();
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/year|yr/.test(s)) return Math.round(n * 12);
  if (/week/.test(s)) return Math.max(1, Math.round(n / 4.345));
  if (/day/.test(s)) return Math.max(1, Math.round(n / 30.44));
  return Math.round(n);
}

/** Monthly payment for an amortising loan: amount at a yearly % over n months. */
export function monthlyPayment(amount: number, yearlyPct: number, months: number): number {
  if (!(amount > 0) || !(months > 0)) return 0;
  const r = yearlyPct / 100 / 12;
  if (r <= 0) return amount / months;
  return (amount * r) / (1 - Math.pow(1 + r, -months));
}

/** Total the client repays at a rate over the term. */
export function totalRepaid(amount: number, rate: Rate, months: number | null): number | null {
  if (!(amount > 0)) return null;
  if (rate.kind === "factor_rate") return amount * rate.value;
  if (!months) return null;
  return monthlyPayment(amount, rate.value, months) * months;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number => { const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : 0; };

export type PricingInput = {
  amount: unknown; lender_rate: unknown; client_rate?: unknown; term?: unknown; term_months?: unknown;
  broker_fee?: unknown; setup_fee?: unknown; proceeds_fee?: unknown; lender_commission?: unknown;
};
export type Revenue = {
  spread: number | null; broker_fee: number; setup_fee: number; proceeds_fee: number; lender_commission: number; total: number;
  /** What the client receives after fees taken from the proceeds. */
  funds_to_client: number | null;
  client_payment: number | null; client_total_repaid: number | null; term_months: number | null;
  note: string | null;
};

export function revenueFor(p: PricingInput): Revenue {
  const amount = num(p.amount);
  const months = (p.term_months !== null && p.term_months !== undefined && num(p.term_months) > 0) ? Math.round(num(p.term_months)) : parseTermMonths(p.term);
  const lender = parseRate(p.lender_rate);
  const clientRaw = p.client_rate === null || p.client_rate === undefined || p.client_rate === "" ? null : p.client_rate;
  const client = clientRaw === null ? lender : (lender ? { kind: lender.kind, value: num(clientRaw) } : parseRate(clientRaw));
  const broker_fee = round2(num(p.broker_fee));
  const setup_fee = round2(num(p.setup_fee));
  const proceeds_fee = round2(num(p.proceeds_fee));
  const lender_commission = round2(num(p.lender_commission));
  let spread: number | null = 0;
  let note: string | null = null;
  if (clientRaw !== null) {
    if (!lender || !client) { spread = null; note = "The lender's rate could not be read, so the rate difference is not counted."; }
    else {
      const a = totalRepaid(amount, client, months);
      const b = totalRepaid(amount, lender, months);
      if (a === null || b === null) { spread = null; note = "Add the term in months to count the rate difference."; }
      else spread = round2(a - b);
    }
  }
  const clientTotal = client ? totalRepaid(amount, client, months) : null;
  const clientPayment = client && months ? (client.kind === "factor_rate" ? (clientTotal ?? 0) / months : monthlyPayment(amount, client.value, months)) : null;
  return {
    spread,
    broker_fee, setup_fee, proceeds_fee, lender_commission,
    total: round2((spread ?? 0) + broker_fee + setup_fee + proceeds_fee + lender_commission),
    funds_to_client: amount > 0 ? round2(amount - proceeds_fee) : null,
    client_payment: clientPayment === null ? null : round2(clientPayment),
    client_total_repaid: clientTotal === null ? null : round2(clientTotal),
    term_months: months,
    note,
  };
}

/** The rate as the client sees it: our rate when we set one, otherwise the lender's text. */
export function clientRateText(lenderRate: unknown, clientRate: unknown): string | null {
  if (clientRate === null || clientRate === undefined || clientRate === "") return lenderRate ? String(lenderRate) : null;
  const lender = parseRate(lenderRate);
  const v = num(clientRate);
  if (lender?.kind === "factor_rate") return `${v} factor`;
  return `${v}%`;
}
