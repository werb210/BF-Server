// BF_SERVER_v867_BROKER_TOOLS_RATE_CARDS - lender rate cards and the structuring tool.
//
// A rate card belongs to a lender product: a grid of term (months) x amount band x credit tier -> rate (APR %) or
// factor, plus the lender's fees and residual / buyout options. Grids come in by CSV (term,min,max,tier,rate). The
// structuring tool takes an amount, the province and the terms to compare, finds every active card that takes the
// deal, and works out the payment for each, with Canadian sales tax applied the way the deal is taxed (on each lease
// payment, financed with the equipment, paid up front, or none). Vendor quotes use the same calculation.
import type { Q } from "./common.js";
import { cents, isoDate, num, str } from "./common.js";
import { normaliseProvince, rateOn, salesTax, type Province, type TaxLine } from "./salesTax.js";

export const RATE_KINDS = ["apr", "factor"] as const;
export type RateKind = (typeof RATE_KINDS)[number];
export const TAX_MODES = ["lease", "financed", "upfront", "none"] as const;
export type TaxMode = (typeof TAX_MODES)[number];
export const TIERS = ["any", "A", "B", "C", "D", "E"] as const;

export type Fee = { label: string; amount: number; taxable: boolean; financed: boolean };
export type Residual = { label: string; pct: number };
export type Cell = { term_months: number; amount_min: number; amount_max: number | null; tier: string; rate: number };
export type RateCard = {
  id: string; lender_id: string | null; lender_product_id: string | null; lender_name: string | null; product_name?: string | null;
  name: string; rate_kind: RateKind; active: boolean; effective_from: string | null; min_amount: number | null; max_amount: number | null;
  fees: Fee[]; residual_options: Residual[]; notes: string | null; cells: Cell[];
};

// ------------------------------------------------------------------------------------------------ CSV
/** Splits CSV text into rows (quoted fields, commas inside quotes, CRLF). */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ""));
}

const HEAD: Record<string, keyof Cell> = {
  term: "term_months", term_months: "term_months", months: "term_months",
  min: "amount_min", amount_min: "amount_min", from: "amount_min", min_amount: "amount_min",
  max: "amount_max", amount_max: "amount_max", to: "amount_max", max_amount: "amount_max",
  tier: "tier", grade: "tier", credit_tier: "tier",
  rate: "rate", apr: "rate", factor: "rate", factor_rate: "rate",
};

/** term,min,max,tier,rate (header names may vary; tier is optional). Errors name the line. */
export function parseRateCsv(text: string): { ok: true; cells: Cell[] } | { ok: false; error: string } {
  const rows = csvRows(text);
  if (rows.length < 2) return { ok: false, error: "The file needs a header line and at least one rate." };
  const cols = rows[0]!.map((h) => HEAD[h.trim().toLowerCase().replace(/[^a-z_]/g, "")] ?? null);
  for (const need of ["term_months", "rate"] as const) if (!cols.includes(need)) return { ok: false, error: `The header needs a "${need === "rate" ? "rate" : "term"}" column.` };
  const cells: Cell[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const get = (k: keyof Cell) => { const j = cols.indexOf(k); return j === -1 ? "" : String(rows[i]![j] ?? "").trim(); };
    const term = Math.floor(Number(get("term_months")));
    const rate = num(get("rate").replace(/%$/, ""));
    const min = get("amount_min") ? num(get("amount_min")) : 0;
    const max = get("amount_max") ? num(get("amount_max")) : null;
    const tier = get("tier") ? get("tier").toUpperCase() === "ANY" ? "any" : get("tier").toUpperCase() : "any";
    if (!(term >= 1 && term <= 120)) return { ok: false, error: `Line ${i + 1}: the term must be 1 to 120 months.` };
    if (rate === null || rate <= 0 || rate > 100) return { ok: false, error: `Line ${i + 1}: the rate must be a number above 0.` };
    if (min === null || min < 0 || (max !== null && max < min)) return { ok: false, error: `Line ${i + 1}: check the amount band.` };
    if (!(TIERS as readonly string[]).includes(tier)) return { ok: false, error: `Line ${i + 1}: tier is A to E, or blank for any.` };
    const key = `${term}|${min}|${tier}`;
    if (seen.has(key)) return { ok: false, error: `Line ${i + 1}: the same term, amount band and tier appear twice.` };
    seen.add(key);
    cells.push({ term_months: term, amount_min: cents(min), amount_max: max === null ? null : cents(max), tier, rate });
  }
  return { ok: true, cells };
}

export function cellsToCsv(cells: Cell[]): string {
  return ["term,min,max,tier,rate", ...cells.map((c) => [c.term_months, c.amount_min, c.amount_max ?? "", c.tier, c.rate].join(","))].join("\n") + "\n";
}

/** The cell for a deal: same term, amount inside the band, the deal's tier (an exact tier beats "any"). */
export function findCell(cells: Cell[], term: number, amount: number, tier: string | null): Cell | null {
  const fits = cells.filter((c) => c.term_months === term && amount >= c.amount_min && (c.amount_max === null || amount <= c.amount_max));
  const t = tier && tier !== "any" ? tier.toUpperCase() : null;
  return (t ? fits.find((c) => c.tier === t) : undefined) ?? fits.find((c) => c.tier === "any") ?? null;
}

// ------------------------------------------------------------------------------------------------ payment maths
/** Level payment for a financed amount at an APR over n months, with a residual (balloon) at the end. In advance:
 *  each payment is due at the start of the month. */
export function aprPayment(financed: number, aprPct: number, n: number, residual = 0, advance = false): number {
  const r = aprPct / 100 / 12;
  if (n <= 0) return 0;
  if (r === 0) return (financed - residual) / n;
  const pv = financed - residual / Math.pow(1 + r, n);
  const pmt = (pv * r) / (1 - Math.pow(1 + r, -n));
  return advance ? pmt / (1 + r) : pmt;
}

export type StructureInput = {
  amount: number; province: Province | null; terms: number[]; tier: string | null; residual_pct: number; down_payment: number;
  tax_mode: TaxMode; advance: boolean; date?: string;
};

export function parseStructureInput(b: Record<string, unknown>, defaults: Partial<StructureInput> = {}): { ok: true; value: StructureInput } | { ok: false; error: string } {
  const amount = num(b.amount ?? defaults.amount);
  if (amount === null || amount <= 0 || amount > 1e10) return { ok: false, error: "Enter the equipment cost." };
  const province = normaliseProvince(b.province ?? defaults.province);
  const rawTerms = Array.isArray(b.terms) ? b.terms : typeof b.terms === "string" ? b.terms.split(/[ ,]+/) : defaults.terms ?? [24, 36, 48, 60];
  const terms = [...new Set((rawTerms as unknown[]).map((t) => Math.floor(Number(t))).filter((t) => t >= 1 && t <= 120))].sort((a, c) => a - c).slice(0, 8);
  if (!terms.length) return { ok: false, error: "Pick at least one term." };
  const residual = num(b.residual_pct ?? defaults.residual_pct ?? 0) ?? 0;
  const down = num(b.down_payment ?? defaults.down_payment ?? 0) ?? 0;
  if (residual < 0 || residual >= 100) return { ok: false, error: "Residual is 0 to 99%." };
  if (down < 0 || down >= amount) return { ok: false, error: "The down payment must be less than the cost." };
  const mode = String(b.tax_mode ?? defaults.tax_mode ?? "lease");
  const tierRaw = str(b.tier ?? defaults.tier, 3);
  return { ok: true, value: {
    amount: cents(amount), province, terms, tier: tierRaw && (TIERS as readonly string[]).includes(tierRaw.toUpperCase() === "ANY" ? "any" : tierRaw.toUpperCase()) ? tierRaw.toUpperCase() : null,
    residual_pct: residual, down_payment: cents(down), tax_mode: (TAX_MODES as readonly string[]).includes(mode) ? (mode as TaxMode) : "lease",
    advance: b.advance === true || b.advance === "true", date: isoDate(b.date) ?? undefined,
  } };
}

export type PaymentOption = {
  card_id: string; lender_name: string | null; product_name: string | null; card_name: string; rate_kind: RateKind; rate: number; tier: string;
  term_months: number; financed: number; residual: number; payment: number; payment_tax: TaxLine[]; payment_with_tax: number;
  upfront: { label: string; amount: number }[]; upfront_total: number; total_of_payments: number; cost_of_borrowing: number;
};

/** One payment option for a card and term, or null when the card has no rate for the deal. */
export function priceOption(card: RateCard, input: StructureInput, term: number, taxRate: Parameters<typeof salesTax>[1] | null): PaymentOption | null {
  const cell = findCell(card.cells, term, input.amount, input.tier);
  if (!cell) return null;
  const tax = (amt: number) => (taxRate && input.tax_mode !== "none" ? salesTax(amt, taxRate) : { lines: [] as TaxLine[], total: 0 });
  const equipTax = input.tax_mode === "financed" || input.tax_mode === "upfront" ? tax(input.amount) : { lines: [] as TaxLine[], total: 0 };
  const financedFees = card.fees.filter((f) => f.financed);
  const upfrontFees = card.fees.filter((f) => !f.financed);
  let financed = input.amount - input.down_payment + financedFees.reduce((s, f) => s + f.amount, 0);
  if (input.tax_mode === "financed") financed += equipTax.total;
  financed = cents(financed);
  const residual = card.rate_kind === "apr" ? cents((input.amount * input.residual_pct) / 100) : 0;
  const payment = cents(card.rate_kind === "factor" ? (financed * cell.rate) / term : aprPayment(financed, cell.rate, term, residual, input.advance));
  const pTax = input.tax_mode === "lease" ? tax(payment) : { lines: [] as TaxLine[], total: 0 };
  const upfront = [
    ...(input.down_payment > 0 ? [{ label: "Down payment", amount: input.down_payment }] : []),
    ...upfrontFees.map((f) => ({ label: f.label, amount: f.amount })),
    ...upfrontFees.filter((f) => f.taxable).flatMap((f) => tax(f.amount).lines.map((l) => ({ label: `${l.label} on ${f.label}`, amount: l.amount }))),
    ...(input.tax_mode === "upfront" ? equipTax.lines.map((l) => ({ label: `${l.label} on the equipment`, amount: l.amount })) : []),
  ];
  const totalPayments = cents((payment + pTax.total) * term);
  return {
    card_id: card.id, lender_name: card.lender_name, product_name: card.product_name ?? null, card_name: card.name, rate_kind: card.rate_kind, rate: cell.rate, tier: cell.tier,
    term_months: term, financed, residual, payment, payment_tax: pTax.lines, payment_with_tax: cents(payment + pTax.total),
    upfront, upfront_total: cents(upfront.reduce((s, u) => s + u.amount, 0)), total_of_payments: totalPayments,
    cost_of_borrowing: cents(payment * term + residual - financed),
  };
}

/** Every active card that takes the amount, each term side by side; cheapest monthly payment first within a term. */
export function structureOptions(cards: RateCard[], input: StructureInput, taxRate: Parameters<typeof salesTax>[1] | null): PaymentOption[] {
  const eligible = cards.filter((c) => c.active && (c.min_amount === null || input.amount >= c.min_amount) && (c.max_amount === null || input.amount <= c.max_amount));
  const out: PaymentOption[] = [];
  for (const term of input.terms) {
    const forTerm = eligible.map((c) => priceOption(c, input, term, taxRate)).filter((o): o is PaymentOption => o !== null);
    out.push(...forTerm.sort((a, b) => a.payment_with_tax - b.payment_with_tax));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ storage
export function parseFees(v: unknown): Fee[] {
  return (Array.isArray(v) ? v : []).map((f: any) => ({ label: str(f?.label, 80) ?? "Fee", amount: cents(num(f?.amount) ?? 0), taxable: f?.taxable === true, financed: f?.financed === true }))
    .filter((f) => f.amount > 0).slice(0, 20);
}
export function parseResiduals(v: unknown): Residual[] {
  return (Array.isArray(v) ? v : []).map((r: any) => ({ label: str(r?.label, 80) ?? `${num(r?.pct) ?? 0}%`, pct: num(r?.pct) ?? 0 }))
    .filter((r) => r.pct >= 0 && r.pct < 100).slice(0, 10);
}

export function parseCardInput(b: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const name = str(b.name, 200);
  if (!name) return { ok: false, error: "Name the rate card." };
  const kind = String(b.rate_kind ?? "apr");
  if (!(RATE_KINDS as readonly string[]).includes(kind)) return { ok: false, error: "The rate is an APR or a factor." };
  const lender = str(b.lender_id, 80), product = str(b.lender_product_id, 80);
  if ((lender && !/^[0-9a-f-]{36}$/i.test(lender)) || (product && !/^[A-Za-z0-9_-]{1,80}$/.test(product))) return { ok: false, error: "Pick the lender from the list." };
  if (!lender && !str(b.lender_name, 200)) return { ok: false, error: "Pick the lender." };
  const min = b.min_amount === "" || b.min_amount == null ? null : num(b.min_amount);
  const max = b.max_amount === "" || b.max_amount == null ? null : num(b.max_amount);
  if ((min !== null && min < 0) || (max !== null && min !== null && max < min)) return { ok: false, error: "Check the amount range." };
  return { ok: true, value: {
    name, rate_kind: kind, lender_id: lender, lender_product_id: product, lender_name: str(b.lender_name, 200), active: b.active !== false,
    effective_from: isoDate(b.effective_from), min_amount: min, max_amount: max, fees: parseFees(b.fees), residual_options: parseResiduals(b.residual_options), notes: str(b.notes, 4000),
  } };
}

const CARD_COLS = `rc.id::text AS id, rc.lender_id::text AS lender_id, rc.lender_product_id, COALESCE(rc.lender_name, l.name) AS lender_name, lp.name AS product_name,
  rc.name, rc.rate_kind, rc.active, rc.effective_from, rc.min_amount, rc.max_amount, rc.fees, rc.residual_options, rc.notes`;

function rowToCard(r: Record<string, any>, cells: Record<string, any>[]): RateCard {
  return {
    id: String(r.id), lender_id: r.lender_id ?? null, lender_product_id: r.lender_product_id ?? null, lender_name: r.lender_name ?? null, product_name: r.product_name ?? null,
    name: String(r.name), rate_kind: r.rate_kind === "factor" ? "factor" : "apr", active: r.active !== false,
    effective_from: r.effective_from ? (r.effective_from instanceof Date ? r.effective_from.toISOString().slice(0, 10) : String(r.effective_from).slice(0, 10)) : null,
    min_amount: r.min_amount === null || r.min_amount === undefined ? null : Number(r.min_amount), max_amount: r.max_amount === null || r.max_amount === undefined ? null : Number(r.max_amount),
    fees: parseFees(r.fees), residual_options: parseResiduals(r.residual_options), notes: r.notes ?? null,
    cells: cells.map((c) => ({ term_months: Number(c.term_months), amount_min: Number(c.amount_min), amount_max: c.amount_max === null ? null : Number(c.amount_max), tier: String(c.tier), rate: Number(c.rate) })),
  };
}

export async function listCards(q: Q, opts: { activeOnly?: boolean; ids?: string[] } = {}): Promise<RateCard[]> {
  const r = await q.query(
    `SELECT ${CARD_COLS} FROM rate_cards rc LEFT JOIN lenders l ON l.id = rc.lender_id LEFT JOIN lender_products lp ON lp.id = rc.lender_product_id
      WHERE ($1::boolean = false OR (rc.active AND (rc.effective_from IS NULL OR rc.effective_from <= CURRENT_DATE)
             AND (rc.lender_product_id IS NULL OR COALESCE(lp.active, true))))
        AND ($2::text[] IS NULL OR rc.id::text = ANY($2::text[]))
      ORDER BY lower(COALESCE(rc.lender_name, l.name, '')), lower(rc.name) LIMIT 500`,
    [opts.activeOnly === true, opts.ids ?? null],
  );
  if (!r.rows.length) return [];
  const cells = await q.query(
    `SELECT card_id::text AS card_id, term_months, amount_min, amount_max, tier, rate FROM rate_card_cells WHERE card_id = ANY($1::uuid[]) ORDER BY term_months, amount_min, tier`,
    [r.rows.map((x: any) => x.id)],
  );
  return r.rows.map((row: any) => rowToCard(row, cells.rows.filter((c: any) => c.card_id === row.id)));
}

export async function getCard(q: Q, id: string): Promise<RateCard | null> {
  return (await listCards(q, { ids: [id] }))[0] ?? null;
}

export async function saveCard(q: Q, id: string | null, v: Record<string, unknown>, actor: string | null): Promise<string> {
  const p = [v.name, v.rate_kind, v.lender_id, v.lender_product_id, v.lender_name, v.active, v.effective_from, v.min_amount, v.max_amount, JSON.stringify(v.fees), JSON.stringify(v.residual_options), v.notes];
  if (id) {
    await q.query(
      `UPDATE rate_cards SET name = $2, rate_kind = $3, lender_id = $4::uuid, lender_product_id = $5, lender_name = $6, active = $7, effective_from = $8::date,
         min_amount = $9, max_amount = $10, fees = $11::jsonb, residual_options = $12::jsonb, notes = $13, updated_at = now() WHERE id = $1::uuid`,
      [id, ...p],
    );
    return id;
  }
  const r = await q.query(
    `INSERT INTO rate_cards (name, rate_kind, lender_id, lender_product_id, lender_name, active, effective_from, min_amount, max_amount, fees, residual_options, notes, created_by)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::date, $8, $9, $10::jsonb, $11::jsonb, $12, $13::uuid) RETURNING id::text AS id`,
    [...p, actor],
  );
  return r.rows[0].id;
}

/** Replaces the card's grid with the CSV's cells. */
export async function replaceCells(q: Q, cardId: string, cells: Cell[]): Promise<number> {
  await q.query(`DELETE FROM rate_card_cells WHERE card_id = $1::uuid`, [cardId]);
  for (let i = 0; i < cells.length; i += 200) {
    const chunk = cells.slice(i, i + 200);
    const params: unknown[] = [cardId];
    const values = chunk.map((c) => {
      params.push(c.term_months, c.amount_min, c.amount_max, c.tier, c.rate);
      const n = params.length;
      return `($1::uuid, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    await q.query(`INSERT INTO rate_card_cells (card_id, term_months, amount_min, amount_max, tier, rate) VALUES ${values.join(", ")}`, params);
  }
  await q.query(`UPDATE rate_cards SET updated_at = now() WHERE id = $1::uuid`, [cardId]);
  return cells.length;
}

/** Runs the structuring tool: active cards, the province's tax rate on the day. */
export async function structure(q: Q, input: StructureInput): Promise<{ options: PaymentOption[]; tax_rate: Awaited<ReturnType<typeof rateOn>> | null; cards_considered: number }> {
  const cards = await listCards(q, { activeOnly: true });
  const taxRate = input.province ? await rateOn(q, input.province, input.date) : null;
  return { options: structureOptions(cards, input, taxRate), tax_rate: taxRate, cards_considered: cards.length };
}
