// BF_SERVER_BLOCK_v535_FINANCIAL_EXTRACTION - financial statement and T2 extraction.
import OpenAI from "openai";
import { pool } from "../../db.js";
import { sharedOpenAI } from "../../lib/sharedClients.js"; // BF_SERVER_SNAT_REUSE_v784

export const LINE_ITEMS = [
  "revenue", "cost_of_sales", "gross_margin", "operating_expenses", "rent_expense", "depreciation_amortization",
  "interest_expense", "income_taxes", "net_income", "ebitda", "cash", "accounts_receivable", "inventory",
  "current_assets", "ppe_net", "total_assets", "accounts_payable", "current_liabilities", "cpltd",
  "long_term_debt", "shareholder_loans", "total_liabilities", "equity", "total_debt_service",
] as const;
export type LineItem = (typeof LINE_ITEMS)[number];
export type PeriodKind = "annual" | "interim" | "forecast";
export type ExtractedPeriod = { label: string; periodEnd: string | null; kind: PeriodKind; items: Partial<Record<LineItem, number>> };

const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || !/\d/.test(text)) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const parsed = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : null;
};

export function normalizeExtraction(raw: any): ExtractedPeriod[] {
  const result: ExtractedPeriod[] = [];
  for (const period of Array.isArray(raw?.periods) ? raw.periods : []) {
    const label = String(period?.label ?? "").trim().slice(0, 40);
    if (!label) continue;
    const kind: PeriodKind = period?.kind === "interim" ? "interim" : period?.kind === "forecast" ? "forecast" : "annual";
    const periodEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(period?.period_end ?? "")) ? String(period.period_end) : null;
    const items: Partial<Record<LineItem, number>> = {};
    for (const item of LINE_ITEMS) {
      const value = num(period?.items?.[item]);
      if (value !== null) items[item] = value;
    }
    if (Object.keys(items).length) result.push({ label, periodEnd, kind, items });
  }
  return result;
}

const PROMPT = [
  "Read Canadian or US business financial statements or a Canadian T2 return (GIFI schedules 100 and 125).",
  "Extract every period, including comparative columns, interim statements and forecasts.",
  "Return only JSON: {\"periods\":[{\"label\":\"FY2024\",\"period_end\":\"YYYY-MM-DD\",\"kind\":\"annual|interim|forecast\",\"items\":{}}]}",
  `Use only these item keys and plain whole-dollar numbers: ${LINE_ITEMS.filter((item) => item !== "ebitda" && item !== "total_debt_service").join(", ")}.`,
  "GIFI: 8299 revenue; 8518 cost of sales; 8519 gross profit; 9367 operating expenses; 8710 interest; 8670 amortization; 9990/9995 taxes; 9999 net income; 1599 current assets; 1001 cash; 1060 receivables; 1120 inventory; 2008 less 2009 ppe_net; 2599 assets; 2620 payables; 3139 current liabilities; 2920 cpltd; 3140 long-term debt; 3260 shareholder loans; 3499 liabilities; 3620 equity.",
  "Convert statements presented in thousands to whole dollars. Omit values not shown and never estimate.",
].join("\n");

export async function extractFromText(text: string): Promise<ExtractedPeriod[]> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const response = await sharedOpenAI(process.env.OPENAI_API_KEY).chat.completions.create({
    model: process.env.CREDIT_LLM_MODEL || process.env.BANKING_LLM_MODEL || "gpt-5.4-mini",
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: PROMPT }, { role: "user", content: text.slice(0, 80000) }],
  });
  try {
    return normalizeExtraction(JSON.parse(response.choices[0]?.message?.content ?? "{}"));
  } catch {
    return [];
  }
}

type Cell = { period: string; period_end: string | null; kind: PeriodKind; line_item: string; value: number; source_document_id: string | null; edited_by: string | null };

export async function extractApplicationFinancials(applicationId: string): Promise<{ documents: number; periods: number; cells: number; skipped: string[] }> {
  // BF_SERVER_CREDIT_DOC_KINDS_v783 - match by requirement label too, not only the canonical key.
  const { documentsOfKinds } = await import("./docKinds.js");
  const docs = { rows: (await documentsOfKinds(applicationId, ["financial_statements", "tax_returns", "interim_financials", "balance_sheet", "profit_and_loss"])).map((d) => ({ id: d.id, name: d.name, text: d.ocr_text })) };
  const skipped: string[] = [];
  let periods = 0;
  let cells = 0;
  for (const document of docs.rows) {
    if (!document.text || document.text.replace(/\s/g, "").length < 200) {
      skipped.push(`${document.name ?? document.id}: no readable text yet`);
      continue;
    }
    const extracted = await extractFromText(document.text);
    periods += extracted.length;
    for (const period of extracted) for (const [item, value] of Object.entries(period.items)) {
      const result = await pool.query(
        `INSERT INTO application_financials (application_id, period, period_end, kind, line_item, value, source_document_id, extracted_by, updated_at)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, 'ai', now())
         ON CONFLICT (application_id, period, line_item) DO UPDATE
           SET value = EXCLUDED.value, period_end = COALESCE(EXCLUDED.period_end, application_financials.period_end),
               kind = EXCLUDED.kind, source_document_id = EXCLUDED.source_document_id, updated_at = now()
         WHERE application_financials.extracted_by = 'ai'`,
        [applicationId, period.label, period.periodEnd, period.kind, item, value, document.id]);
      cells += result.rowCount ?? 0;
    }
  }
  return { documents: docs.rows.length, periods, cells, skipped };
}

export type FinancialTable = {
  periods: { label: string; periodEnd: string | null; kind: PeriodKind }[];
  rows: { item: string; values: (number | null)[]; derived: boolean; sources: (string | null)[]; edited: boolean[] }[];
};
const round2 = (value: number) => Math.round(value * 100) / 100;

// BF_SERVER_v885_CREDIT_PERIODS - two documents for the same period (a balance sheet and a
// P&L) were read with different labels ("Jan-Jul 2026", "January-July 2026", "FY2026") and
// became separate columns. Columns with the same normalised label, or the same period end
// and no conflicting figures, are one column.
const MONTHS: Record<string, string> = { january: "jan", february: "feb", march: "mar", april: "apr", june: "jun", july: "jul", august: "aug", september: "sep", sept: "sep", october: "oct", november: "nov", december: "dec" };
export function normalizePeriodLabel(label: string): string {
  return String(label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").map((w) => MONTHS[w] ?? w).join(" ");
}
type PeriodGroup = { label: string; periodEnd: string | null; kind: PeriodKind; members: string[] };
function groupPeriods(cells: Cell[]): PeriodGroup[] {
  const raw = new Map<string, { periodEnd: string | null; kind: PeriodKind }>();
  for (const cell of cells) if (!raw.has(cell.period)) raw.set(cell.period, { periodEnd: cell.period_end, kind: cell.kind });
  const groups: PeriodGroup[] = [];
  const itemsOf = (g: PeriodGroup) => cells.filter((c) => g.members.includes(c.period));
  const conflicts = (a: PeriodGroup, b: PeriodGroup) => {
    const bi = itemsOf(b);
    return itemsOf(a).some((x) => bi.some((y) => y.line_item === x.line_item && Math.abs(Number(y.value) - Number(x.value)) > Math.max(1, Math.abs(Number(x.value)) * 0.01)));
  };
  for (const [label, d] of raw) {
    const g: PeriodGroup = { label, periodEnd: d.periodEnd, kind: d.kind, members: [label] };
    const same = groups.find((x) => normalizePeriodLabel(x.label) === normalizePeriodLabel(label) && !conflicts(x, g))
      ?? (d.periodEnd ? groups.find((x) => x.periodEnd === d.periodEnd && !conflicts(x, g)) : undefined);
    if (!same) { groups.push(g); continue; }
    same.members.push(label);
    same.periodEnd = same.periodEnd ?? d.periodEnd;
    // The column is named after the document that carries the income statement.
    const hasRevenue = (labels: string[]) => cells.some((c) => labels.includes(c.period) && c.line_item === "revenue");
    if (!hasRevenue([same.label]) && hasRevenue([label])) { same.label = label; same.kind = d.kind; }
  }
  return groups;
}

export function buildTable(cells: Cell[]): FinancialTable {
  const groups = groupPeriods(cells);
  const rank: Record<PeriodKind, number> = { annual: 0, interim: 1, forecast: 2 };
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || String(a.periodEnd ?? a.label).localeCompare(String(b.periodEnd ?? b.label)));
  const periods = groups.map((g) => ({ label: g.label, periodEnd: g.periodEnd, kind: g.kind }));
  const membersOf = new Map(groups.map((g) => [g.label, g.members]));
  const get = (period: string, item: string) => {
    const members = membersOf.get(period) ?? [period];
    const matches = cells.filter((cell) => members.includes(cell.period) && cell.line_item === item);
    return matches.find((cell) => cell.edited_by) ?? matches[0];
  };
  const val = (period: string, item: string) => { const cell = get(period, item); return cell ? Number(cell.value) : null; };
  // BF_SERVER_v885_CREDIT_PERIODS - a statement with no cost of sales reports "gross profit" equal to
  // revenue; that is not a gross margin, so it is left blank rather than repeating revenue.
  const grossMargin = (p: string) => {
    const rev = val(p, "revenue"); const cos = val(p, "cost_of_sales"); const gm = val(p, "gross_margin");
    if (gm !== null) return rev !== null && !cos && Math.abs(gm - rev) <= 1 && !get(p, "gross_margin")?.edited_by ? null : gm;
    return rev !== null && cos !== null ? rev - cos : null;
  };
  const derived: Record<string, (period: string) => number | null> = {
    gross_margin: grossMargin,
    ebitda: (p) => val(p, "ebitda") ?? (val(p, "net_income") !== null ? val(p, "net_income")! + (val(p, "interest_expense") ?? 0) + (val(p, "income_taxes") ?? 0) + (val(p, "depreciation_amortization") ?? 0) : null),
    ebitda_plus_rent: (p) => { const e = derived.ebitda!(p); const rent = val(p, "rent_expense"); return e !== null && rent !== null ? e + rent : null; },
    total_debt_service: (p) => val(p, "total_debt_service") ?? (val(p, "cpltd") !== null ? val(p, "cpltd")! + (val(p, "interest_expense") ?? 0) : null),
    dscr: (p) => { const e = derived.ebitda!(p); const debt = derived.total_debt_service!(p); return e !== null && debt ? round2(e / debt) : null; },
    current_ratio: (p) => { const assets = val(p, "current_assets"); const liabilities = val(p, "current_liabilities"); return assets !== null && liabilities ? round2(assets / liabilities) : null; },
    debt_to_equity: (p) => { const debt = val(p, "long_term_debt"); const equity = val(p, "equity"); return debt !== null && equity ? round2(debt / equity) : null; },
  };
  const order = ["revenue", "gross_margin", "ebitda", "ebitda_plus_rent", "net_income", "total_debt_service", "dscr", "current_assets", "current_liabilities", "current_ratio", "accounts_receivable", "inventory", "ppe_net", "long_term_debt", "equity", "debt_to_equity"];
  const rows: FinancialTable["rows"] = [];
  for (const item of order) {
    const values = periods.map((period) => derived[item] ? derived[item]!(period.label) : val(period.label, item));
    if (values.every((value) => value === null)) continue;
    rows.push({ item, values, derived: Boolean(derived[item]) && periods.some((period) => !get(period.label, item)), sources: periods.map((period) => get(period.label, item)?.source_document_id ?? null), edited: periods.map((period) => Boolean(get(period.label, item)?.edited_by)) });
  }
  return { periods, rows };
}

export async function loadFinancialTable(applicationId: string): Promise<FinancialTable> {
  const result = await pool.query<Cell>(`SELECT period, to_char(period_end, 'YYYY-MM-DD') AS period_end, kind, line_item, value, source_document_id, edited_by FROM application_financials WHERE application_id = $1`, [applicationId]);
  return buildTable(result.rows);
}

export async function setFinancialCell(applicationId: string, input: { period: string; kind?: string; periodEnd?: string | null; item: string; value: number | null }, userId: string | null): Promise<void> {
  if (!(LINE_ITEMS as readonly string[]).includes(input.item)) throw new Error("unknown_line_item");
  const period = String(input.period ?? "").trim().slice(0, 40);
  if (!period) throw new Error("period_required");
  if (input.value === null) {
    await pool.query(`DELETE FROM application_financials WHERE application_id = $1 AND period = $2 AND line_item = $3`, [applicationId, period, input.item]);
    return;
  }
  const kind = input.kind === "interim" || input.kind === "forecast" ? input.kind : "annual";
  await pool.query(
    `INSERT INTO application_financials (application_id, period, period_end, kind, line_item, value, extracted_by, edited_by, updated_at)
     VALUES ($1, $2, $3::date, $4, $5, $6, 'staff', $7, now())
     ON CONFLICT (application_id, period, line_item) DO UPDATE
       SET value = EXCLUDED.value, extracted_by = 'staff', edited_by = EXCLUDED.edited_by, updated_at = now()`,
    [applicationId, period, /^\d{4}-\d{2}-\d{2}$/.test(String(input.periodEnd ?? "")) ? input.periodEnd : null, kind, input.item, input.value, userId]);
}
