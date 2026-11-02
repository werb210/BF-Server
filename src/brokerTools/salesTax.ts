// BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX - Canadian sales tax (GST, HST, PST/RST, QST) by province, as one shared helper.
//
// The rates live in sales_tax_rates: one row per province and "as of" date, so a rate change is a new row and old
// quotes keep the rate of their day. An Admin edits them in Settings > Deal tools. When the table has no row for a
// province (or cannot be read), DEFAULT_RATES below is used - the rates in force from 1 April 2025 (Nova Scotia HST
// 14%). The helper only adds up tax; what is taxable is the caller's choice (for a quote: the fees ticked "taxable";
// interest and factor cost are financial services and never taxed).
import type { Q } from "./common.js";

export const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export type Province = (typeof PROVINCES)[number];

export const PROVINCE_NAMES: Record<Province, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};

/** Percentages: 5 = 5%. A province charges either HST alone, or GST plus (optionally) PST or QST. */
export type TaxRate = { province: Province; effective_from: string; gst: number; pst: number; hst: number; qst: number; note: string | null };
export type TaxLine = { label: string; amount: number };

const AS_OF = "2025-04-01";
const row = (province: Province, gst: number, pst: number, hst: number, qst: number): TaxRate =>
  ({ province, effective_from: AS_OF, gst, pst, hst, qst, note: null });

export const DEFAULT_RATES: readonly TaxRate[] = [
  row("AB", 5, 0, 0, 0), row("BC", 5, 7, 0, 0), row("MB", 5, 7, 0, 0), row("NB", 0, 0, 15, 0), row("NL", 0, 0, 15, 0),
  row("NS", 0, 0, 14, 0), row("NT", 5, 0, 0, 0), row("NU", 5, 0, 0, 0), row("ON", 0, 0, 13, 0), row("PE", 0, 0, 15, 0),
  row("QC", 5, 0, 0, 9.975), row("SK", 5, 6, 0, 0), row("YT", 5, 0, 0, 0),
];

const BY_NAME: Record<string, Province> = Object.fromEntries(
  (Object.entries(PROVINCE_NAMES) as [Province, string][]).flatMap(([code, name]) => [[name.toLowerCase(), code], [code.toLowerCase(), code]]),
);
Object.assign(BY_NAME, { "pei": "PE", "p.e.i.": "PE", "newfoundland": "NL", "nfld": "NL", "que": "QC", "qu\u00e9bec": "QC", "nwt": "NT", "yukon territory": "YT", "sask": "SK", "man": "MB", "alta": "AB", "ont": "ON", "b.c.": "BC" });

/** "Ontario", "on", " ON " -> "ON". Anything else (a US state, blank) -> null. */
export function normaliseProvince(v: unknown): Province | null {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return null;
  return BY_NAME[t] ?? null;
}

const r2 = (n: number) => Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
const pct = (n: number) => `${Number(n.toFixed(3))}%`;

/** The tax lines on a taxable amount: "HST 13%" or "GST 5%" plus "PST 7%" / "RST 7%" (Manitoba) / "QST 9.975%". */
export function salesTax(amount: number, rate: TaxRate): { lines: TaxLine[]; total: number } {
  const base = Number(amount);
  if (!(base > 0)) return { lines: [], total: 0 };
  const lines: TaxLine[] = [];
  if (rate.hst > 0) lines.push({ label: `HST ${pct(rate.hst)}`, amount: r2((base * rate.hst) / 100) });
  else {
    if (rate.gst > 0) lines.push({ label: `GST ${pct(rate.gst)}`, amount: r2((base * rate.gst) / 100) });
    if (rate.pst > 0) lines.push({ label: `${rate.province === "MB" ? "RST" : "PST"} ${pct(rate.pst)}`, amount: r2((base * rate.pst) / 100) });
    if (rate.qst > 0) lines.push({ label: `QST ${pct(rate.qst)}`, amount: r2((base * rate.qst) / 100) });
  }
  return { lines, total: r2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/** The combined percentage (13 for Ontario, 14.975 for Quebec). */
export function combinedRate(rate: TaxRate): number {
  return rate.hst > 0 ? rate.hst : Number((rate.gst + rate.pst + rate.qst).toFixed(3));
}

/** A fee-tax function for the quote maths: tax on the fees marked taxable, in the given province's rate. */
export function feeTaxFor(rate: TaxRate | null): (fees: { amount: number; taxable?: boolean }[]) => TaxLine[] {
  return (fees) => {
    if (!rate) return [];
    const base = fees.filter((f) => f.taxable === true).reduce((s, f) => s + (Number(f.amount) || 0), 0);
    return salesTax(base, rate).lines;
  };
}

export function defaultRate(province: Province): TaxRate {
  return { ...DEFAULT_RATES.find((r) => r.province === province)! };
}

function fromRow(r: any): TaxRate {
  const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10));
  return {
    province: r.province, effective_from: day(r.effective_from), gst: Number(r.gst) || 0, pst: Number(r.pst) || 0,
    hst: Number(r.hst) || 0, qst: Number(r.qst) || 0, note: r.note ?? null,
  };
}

/** The rate for a province on a day (YYYY-MM-DD, default today): the latest row whose as-of date is on or before it. */
export async function rateOn(q: Q, province: Province, onDate?: string): Promise<TaxRate> {
  const d = onDate && /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : new Date().toISOString().slice(0, 10);
  try {
    const r = await q.query(
      `SELECT province, effective_from, gst, pst, hst, qst, note FROM sales_tax_rates
        WHERE province = $1 AND effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1`,
      [province, d],
    );
    if (r.rows[0]) return fromRow(r.rows[0]);
  } catch (err) {
    console.error("[sales-tax] rate lookup failed - using the built-in rate", { province, message: err instanceof Error ? err.message : String(err) });
  }
  return defaultRate(province);
}

/** Every row, newest as-of date first within each province. */
export async function listRates(q: Q): Promise<TaxRate[]> {
  const r = await q.query(`SELECT province, effective_from, gst, pst, hst, qst, note FROM sales_tax_rates ORDER BY province, effective_from DESC`);
  return r.rows.map(fromRow);
}

/** The rate in force today for every province (table first, built-in otherwise). */
export function currentRates(rows: TaxRate[], today: string = new Date().toISOString().slice(0, 10)): TaxRate[] {
  return PROVINCES.map((p) => rows.filter((r) => r.province === p && r.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? defaultRate(p));
}

/** Checks an Admin's edit. HST cannot be combined with GST/PST/QST; every rate is 0 to 30. */
export function parseRateInput(body: Record<string, unknown>): { ok: true; rate: TaxRate } | { ok: false; error: string } {
  const province = normaliseProvince(body.province);
  if (!province) return { ok: false, error: "Pick a province or territory." };
  const day = String(body.effective_from ?? "").trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const valid = m && (() => { const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); return d.getUTCDate() === +m[3]; })();
  if (!valid) return { ok: false, error: "The as-of date must be a date (YYYY-MM-DD)." };
  const n = (k: string) => { const v = body[k]; if (v === undefined || v === null || v === "") return 0; const x = Number(v); return Number.isFinite(x) ? x : NaN; };
  const [gst, pst, hst, qst] = ["gst", "pst", "hst", "qst"].map(n);
  if ([gst, pst, hst, qst].some((x) => !(x >= 0 && x <= 30))) return { ok: false, error: "Each rate is a percentage from 0 to 30." };
  if (hst > 0 && (gst > 0 || pst > 0 || qst > 0)) return { ok: false, error: "HST replaces GST and PST: enter HST alone, or GST with PST or QST." };
  if (pst > 0 && qst > 0) return { ok: false, error: "A province charges PST or QST, not both." };
  const note = String(body.note ?? "").trim().slice(0, 300) || null;
  return { ok: true, rate: { province, effective_from: day, gst, pst, hst, qst, note } };
}

export async function saveRate(q: Q, rate: TaxRate, userId: string | null): Promise<void> {
  await q.query(
    `INSERT INTO sales_tax_rates (province, effective_from, gst, pst, hst, qst, note, updated_by, updated_at)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (province, effective_from) DO UPDATE
       SET gst = EXCLUDED.gst, pst = EXCLUDED.pst, hst = EXCLUDED.hst, qst = EXCLUDED.qst, note = EXCLUDED.note,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [rate.province, rate.effective_from, rate.gst, rate.pst, rate.hst, rate.qst, rate.note, userId],
  );
}

export async function deleteRate(q: Q, province: Province, effectiveFrom: string): Promise<boolean> {
  const r = await q.query(`DELETE FROM sales_tax_rates WHERE province = $1 AND effective_from = $2::date`, [province, effectiveFrom]);
  return (r.rowCount ?? 0) > 0;
}

/** The province of the business on an application: the company's province, then the application's own fields. */
export async function applicationProvince(q: Q, applicationId: string): Promise<Province | null> {
  const r = await q.query(
    `SELECT c.province AS company_province, a.metadata->>'province' AS meta_province,
            a.metadata->'business'->>'province' AS business_province, a.metadata->'company'->>'province' AS meta_company_province
       FROM applications a LEFT JOIN companies c ON c.id = a.company_id WHERE a.id::text = $1 LIMIT 1`,
    [applicationId],
  );
  const x = r.rows[0];
  if (!x) return null;
  return normaliseProvince(x.company_province) ?? normaliseProvince(x.meta_province) ?? normaliseProvince(x.business_province) ?? normaliseProvince(x.meta_company_province);
}
