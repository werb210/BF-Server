// BF_SERVER_v942_DEAL_CLOSE_REVENUE - the Close tab and the revenue behind it (Todd, Nov 11 2026): once the client signs a
// term sheet the broker records what closed (date, currency, amount, rate, term, lender) and every way the brokerage is
// paid. Saving also writes the funded figures onto the application, so the existing reports keep working.
import { revenueFor } from "../offers/pricing.js";
import { parseCommissionTerms } from "../lenderRules/rules.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const LINE_KINDS = ["lender_commission", "residual", "client_fee", "setup_fee", "proceeds_fee", "spread", "referral_fee", "other"] as const;
export type LineKind = (typeof LINE_KINDS)[number];
export type RevenueLine = {
  id?: string; kind: LineKind; description: string | null; basis: "flat" | "percent"; percent: number | null; expected_amount: number | null;
  month?: string | null; due_on?: string | null; received_amount?: number | null; received_on?: string | null; status?: string;
};
export type CloseInput = {
  offer_id?: string | null; closed_on: string; currency: "CAD" | "USD"; funded_amount: number; rate?: string | null; term_months?: number | null;
  payment_frequency?: string | null; lender_id?: string | null; lender_name?: string | null; lender_product_id?: string | null;
  broker_user_id?: string | null; lead_source?: "self" | "company"; clawback_days?: number | null; residual_percent?: number | null;
  residual_months?: number | null; renewal_of_application_id?: string | null; notes?: string | null; lines: RevenueLine[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const IN_KINDS = new Set<LineKind>(["lender_commission", "residual", "client_fee", "setup_fee", "proceeds_fee", "spread", "other"]);

/** Cleans what the Close tab sends. Throws with a readable message. */
export function parseClose(body: any): CloseInput {
  const b = body ?? {};
  const closed_on = String(b.closed_on ?? b.closedOn ?? "").slice(0, 10);
  if (!DATE.test(closed_on)) throw new Error("Enter the close date.");
  const currency = String(b.currency ?? "CAD").toUpperCase();
  if (currency !== "CAD" && currency !== "USD") throw new Error("Choose CAD or USD.");
  const funded = num(b.funded_amount ?? b.fundedAmount);
  if (funded === null || funded <= 0) throw new Error("Enter the amount funded.");
  const lines: RevenueLine[] = (Array.isArray(b.lines) ? b.lines : []).map((l: any) => {
    const kind = String(l?.kind ?? "") as LineKind;
    if (!(LINE_KINDS as readonly string[]).includes(kind)) throw new Error("Unknown revenue type.");
    const basis = l?.basis === "percent" ? "percent" : "flat";
    const percent = num(l?.percent);
    const expected = basis === "percent" && percent !== null ? r2(funded * percent / 100) : num(l?.expected_amount ?? l?.amount);
    return { id: typeof l?.id === "string" ? l.id : undefined, kind, description: l?.description ? String(l.description).slice(0, 200) : null, basis, percent, expected_amount: expected,
      month: DATE.test(String(l?.month ?? "")) ? String(l.month) : null, due_on: DATE.test(String(l?.due_on ?? "")) ? String(l.due_on) : null };
  });
  const lead = b.lead_source === "self" ? "self" : "company";
  return {
    offer_id: b.offer_id ?? null, closed_on, currency: currency as "CAD" | "USD", funded_amount: funded,
    rate: b.rate ? String(b.rate).slice(0, 40) : null, term_months: num(b.term_months) !== null ? Math.round(num(b.term_months)!) : null,
    payment_frequency: b.payment_frequency ? String(b.payment_frequency).slice(0, 40) : null,
    lender_id: b.lender_id ?? null, lender_name: b.lender_name ? String(b.lender_name).slice(0, 200) : null, lender_product_id: b.lender_product_id ?? null,
    broker_user_id: typeof b.broker_user_id === "string" && b.broker_user_id ? b.broker_user_id : null, lead_source: lead,
    clawback_days: num(b.clawback_days) !== null ? Math.round(num(b.clawback_days)!) : null,
    residual_percent: num(b.residual_percent), residual_months: num(b.residual_months) !== null ? Math.round(num(b.residual_months)!) : null,
    renewal_of_application_id: b.renewal_of_application_id ?? null, notes: b.notes ? String(b.notes).slice(0, 2000) : null, lines,
  };
}

/** Starting point for a new close: the signed offer, its pricing, the lender product's commission terms, the referral fee. */
export async function suggestClose(q: Q, applicationId: string): Promise<CloseInput & { referral_partner: string | null }> {
  const app = (await q.query(
    `SELECT a.id::text AS id, a.owner_user_id::text AS owner_user_id, a.requested_amount, a.lender_id::text AS lender_id, a.lender_product_id::text AS lender_product_id
       FROM applications a WHERE a.id::text = $1 LIMIT 1`, [applicationId])).rows[0] ?? {};
  const offer = (await q.query(
    `SELECT o.id::text AS id, o.lender_name, o.amount, o.rate_factor, o.term, o.payment_frequency, o.term_sheet_mode, o.client_rate, o.term_months,
            o.broker_fee, o.setup_fee, o.proceeds_fee, o.lender_commission
       FROM offers o WHERE o.application_id::text = $1 AND COALESCE(o.is_archived, false) = false
      ORDER BY (o.status = 'accepted') DESC, (o.status = 'pending_acceptance') DESC, o.updated_at DESC LIMIT 1`, [applicationId])).rows[0] ?? null;
  const product = app.lender_product_id ? (await q.query(`SELECT commission_terms, commission FROM lender_products WHERE id::text = $1 LIMIT 1`, [app.lender_product_id])).rows[0] ?? null : null;
  const terms = parseCommissionTerms(product?.commission_terms ?? {}) ?? {};
  const funded = num(offer?.amount) ?? num(app.requested_amount) ?? 0;
  const lines: RevenueLine[] = [];
  const kind = terms.kind ?? (num(product?.commission) ? "percent" : null);
  if (kind === "flat" && terms.amount) lines.push({ kind: "lender_commission", description: "Lender commission", basis: "flat", percent: null, expected_amount: terms.amount });
  if (kind === "percent") { const pct = terms.percent ?? num(product?.commission); if (pct) lines.push({ kind: "lender_commission", description: "Lender commission", basis: "percent", percent: pct, expected_amount: r2(funded * pct / 100) }); }
  if (offer) {
    const rev = revenueFor({ amount: offer.amount, lender_rate: offer.rate_factor, client_rate: offer.client_rate, term: offer.term, term_months: offer.term_months,
      broker_fee: offer.broker_fee, setup_fee: offer.setup_fee, proceeds_fee: offer.proceeds_fee, lender_commission: offer.lender_commission });
    if (rev.broker_fee) lines.push({ kind: "client_fee", description: "Broker fee", basis: "flat", percent: null, expected_amount: rev.broker_fee });
    if (rev.setup_fee) lines.push({ kind: "setup_fee", description: "Set-up fee", basis: "flat", percent: null, expected_amount: rev.setup_fee });
    if (rev.proceeds_fee) lines.push({ kind: "proceeds_fee", description: "Fee from proceeds", basis: "flat", percent: null, expected_amount: rev.proceeds_fee });
    if (rev.spread) lines.push({ kind: "spread", description: "Rate difference over the term", basis: "flat", percent: null, expected_amount: rev.spread });
    if (rev.lender_commission && !lines.some((l) => l.kind === "lender_commission")) lines.push({ kind: "lender_commission", description: "Lender commission", basis: "flat", percent: null, expected_amount: rev.lender_commission });
  }
  // The referral partner's fee: their rate on what the brokerage earns up front.
  let referral_partner: string | null = null;
  try {
    const ref = (await q.query(
      `SELECT rc.conversion_rate, COALESCE(NULLIF(trim(concat_ws(' ', u.first_name, u.last_name)), ''), u.email) AS name
         FROM referral_conversions rc LEFT JOIN users u ON u.id = rc.referrer_id
        WHERE rc.application_id::text = $1 ORDER BY rc.created_at DESC LIMIT 1`, [applicationId])).rows[0];
    if (ref) {
      referral_partner = ref.name ?? "the referral partner";
      const base = lines.filter((l) => IN_KINDS.has(l.kind)).reduce((a, l) => a + (l.expected_amount ?? 0), 0);
      const rate = num(ref.conversion_rate) ?? 0;
      if (base > 0 && rate > 0) lines.push({ kind: "referral_fee", description: `Referral fee owed to ${referral_partner} (${rate}%)`, basis: "flat", percent: null, expected_amount: r2(base * rate / 100) });
    }
  } catch (err) {
    console.warn("[deal-close] referral fee not read", { applicationId, message: err instanceof Error ? err.message : String(err) });
  }
  return {
    offer_id: offer?.id ?? null, closed_on: new Date().toISOString().slice(0, 10), currency: "CAD", funded_amount: funded,
    rate: offer ? tidyRate(offer.term_sheet_mode === "ours" && offer.client_rate ? String(offer.client_rate) : offer.rate_factor ?? null) : null,
    term_months: num(offer?.term_months) ?? monthsFromTerm(offer?.term), payment_frequency: offer?.payment_frequency ?? null,
    lender_id: app.lender_id ?? null, lender_name: offer?.term_sheet_mode === "ours" ? offer?.lender_name ?? null : offer?.lender_name ?? null,
    lender_product_id: app.lender_product_id ?? null, broker_user_id: app.owner_user_id ?? null, lead_source: "company",
    clawback_days: terms.clawback_days ?? null, residual_percent: kind === "profit_share" ? terms.share_percent ?? null : null,
    residual_months: kind === "profit_share" ? terms.share_months ?? null : null, renewal_of_application_id: null, notes: null, lines, referral_partner,
  };
}

const CLOSE_COLS = `id::text AS id, application_id, offer_id, to_char(closed_on, 'YYYY-MM-DD') AS closed_on, currency, funded_amount::float8 AS funded_amount, rate,
  term_months, payment_frequency, lender_id::text AS lender_id, lender_name, lender_product_id, broker_user_id::text AS broker_user_id, lead_source, clawback_days,
  residual_percent::float8 AS residual_percent, residual_months, renewal_of_application_id, status, notes, created_at, updated_at`;
const LINE_COLS = `id::text AS id, close_id::text AS close_id, application_id, kind, description, basis, percent::float8 AS percent, expected_amount::float8 AS expected_amount,
  to_char(month, 'YYYY-MM-DD') AS month, to_char(due_on, 'YYYY-MM-DD') AS due_on, received_amount::float8 AS received_amount, to_char(received_on, 'YYYY-MM-DD') AS received_on,
  to_char(clawed_back_on, 'YYYY-MM-DD') AS clawed_back_on, status`;

export async function loadClose(q: Q, applicationId: string) {
  const close = (await q.query(`SELECT ${CLOSE_COLS} FROM deal_closes WHERE application_id = $1 LIMIT 1`, [applicationId])).rows[0] ?? null;
  if (!close) return null;
  const lines = (await q.query(`SELECT ${LINE_COLS} FROM deal_revenue_lines WHERE close_id = $1::uuid ORDER BY kind, month NULLS FIRST, created_at`, [close.id])).rows;
  return { close, lines };
}

/** Saves the close. Lines already received (or clawed back) are never changed here; the others are replaced. */
export async function saveClose(q: Q, applicationId: string, input: CloseInput, actor: string | null) {
  const saved = (await q.query(
    `INSERT INTO deal_closes (application_id, offer_id, closed_on, currency, funded_amount, rate, term_months, payment_frequency, lender_id, lender_name,
                              lender_product_id, broker_user_id, lead_source, clawback_days, residual_percent, residual_months, renewal_of_application_id, notes, created_by)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9::uuid,$10,$11,$12::uuid,$13,$14,$15,$16,$17,$18,$19::uuid)
     ON CONFLICT (application_id) DO UPDATE SET offer_id = EXCLUDED.offer_id, closed_on = EXCLUDED.closed_on, currency = EXCLUDED.currency,
       funded_amount = EXCLUDED.funded_amount, rate = EXCLUDED.rate, term_months = EXCLUDED.term_months, payment_frequency = EXCLUDED.payment_frequency,
       lender_id = EXCLUDED.lender_id, lender_name = EXCLUDED.lender_name, lender_product_id = EXCLUDED.lender_product_id, broker_user_id = EXCLUDED.broker_user_id,
       lead_source = EXCLUDED.lead_source, clawback_days = EXCLUDED.clawback_days, residual_percent = EXCLUDED.residual_percent, residual_months = EXCLUDED.residual_months,
       renewal_of_application_id = EXCLUDED.renewal_of_application_id, notes = EXCLUDED.notes, updated_at = now()
     RETURNING id::text AS id`,
    [applicationId, input.offer_id, input.closed_on, input.currency, input.funded_amount, input.rate, input.term_months, input.payment_frequency,
      input.lender_id, input.lender_name, input.lender_product_id, input.broker_user_id, input.lead_source ?? "company", input.clawback_days,
      input.residual_percent, input.residual_months, input.renewal_of_application_id, input.notes, actor],
  )).rows[0];
  const closeId = String(saved.id);
  const keep = input.lines.filter((l) => l.id).map((l) => l.id!);
  await q.query(`DELETE FROM deal_revenue_lines WHERE close_id = $1::uuid AND status = 'expected' AND NOT (id::text = ANY($2::text[]))`, [closeId, keep]);
  for (const l of input.lines) {
    if (l.id) {
      await q.query(
        `UPDATE deal_revenue_lines SET kind = $3, description = $4, basis = $5, percent = $6, expected_amount = $7, month = $8::date, due_on = $9::date, updated_at = now()
          WHERE id::text = $1 AND close_id = $2::uuid AND status = 'expected'`,
        [l.id, closeId, l.kind, l.description, l.basis, l.percent, l.expected_amount, l.month ?? null, l.due_on ?? null]);
    } else {
      await q.query(
        `INSERT INTO deal_revenue_lines (close_id, application_id, kind, description, basis, percent, expected_amount, month, due_on)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::date, $9::date)`,
        [closeId, applicationId, l.kind, l.description, l.basis, l.percent, l.expected_amount, l.month ?? null, l.due_on ?? null]);
    }
  }
  // The funded figures on the application feed the existing reports, Active Contracts and conversions.
  await q.query(
    `UPDATE applications SET funded_amount = $2, funded_currency = $3, funded_at = COALESCE(funded_at, $4::date), updated_at = now() WHERE id::text = $1`,
    [applicationId, input.funded_amount, input.currency, input.closed_on]);
  return loadClose(q, applicationId);
}

export async function markReceived(q: Q, lineId: string, amount: number, on: string) {
  return (await q.query(
    `UPDATE deal_revenue_lines SET received_amount = $2, received_on = $3::date, status = 'received', updated_at = now()
      WHERE id::text = $1 AND status IN ('expected', 'received') RETURNING ${LINE_COLS}`, [lineId, amount, on])).rows[0] ?? null;
}

export async function clawBack(q: Q, lineId: string, on: string) {
  return (await q.query(
    `UPDATE deal_revenue_lines SET status = 'clawed_back', clawed_back_on = $2::date, updated_at = now()
      WHERE id::text = $1 AND status = 'received' RETURNING ${LINE_COLS}`, [lineId, on])).rows[0] ?? null;
}

/** A month of profit share, entered from the lender's statement (it changes every month). */
export async function addResidual(q: Q, closeId: string, month: string, amount: number, receivedOn: string | null) {
  const c = (await q.query(`SELECT application_id, residual_percent FROM deal_closes WHERE id::text = $1 LIMIT 1`, [closeId])).rows[0];
  if (!c) return null;
  return (await q.query(
    `INSERT INTO deal_revenue_lines (close_id, application_id, kind, description, basis, percent, expected_amount, month, received_amount, received_on, status)
     VALUES ($1::uuid, $2, 'residual', $3, 'flat', $4, $5, $6::date, $7, $8::date, $9) RETURNING ${LINE_COLS}`,
    [closeId, c.application_id, `Profit share for ${month.slice(0, 7)}`, c.residual_percent, amount, month, receivedOn ? amount : null, receivedOn, receivedOn ? "received" : "expected"])).rows[0];
}

/** CLOSE_PREFILL - "9.5000" reads as "9.5"; anything that is not a plain number is left as written. */
export function tidyRate(v: string | null | undefined): string | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const t = String(v).trim();
  return /^\d+\.\d+$/.test(t) ? t.replace(/\.?0+$/, "") : t;
}
/** CLOSE_PREFILL - the months in a term written as text ("60 months", "5 years", "36"); null when it cannot be read. */
export function monthsFromTerm(term: string | null | undefined): number | null {
  const t = String(term ?? "").trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(months?|mos?|m|years?|yrs?|y)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] && m[2].startsWith("y") ? 12 : 1);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}
