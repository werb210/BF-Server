// BF_SERVER_BANK_COVERAGE_v267
// Which months the bank statements on an application cover, and which required
// months are missing. Per statement, the first source that yields a date wins:
//   1. transactions server banking analysis extracted from that document,
//   2. the period staff typed when accepting ("July", v266),
//   3. a date in the uploaded filename ("20260831-statements.pdf").
// Statements none of these can date are counted so staff can name them.
import { pool } from "../../db.js";
import { resolveExpectedDocumentKey } from "./classifyDocument.js";
import { periodFromFilename } from "./documentNaming.js";

export const DEFAULT_REQUIRED_MONTHS = 6;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthKey = (year: number, monthIndex: number) => `${year}-${String(monthIndex + 1).padStart(2, "0")}`;

export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return monthKey(d.getUTCFullYear(), d.getUTCMonth());
}

export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
}

export type MonthSpan = { months: string[]; partial: boolean };

/** Staff-typed period: "July", "Jul 2026", "2026-07", "07/2026", "June-July", "September 1-11". */
export function parsePeriodText(text: string | null | undefined, referenceMonth: string): MonthSpan | null {
  const raw = String(text ?? "").toLowerCase().trim();
  if (!raw) return null;
  const iso = raw.match(/(20\d{2})-(0[1-9]|1[0-2])(?!\d)/);
  if (iso) return { months: [`${iso[1]}-${iso[2]}`], partial: false };
  const slash = raw.match(/(?<!\d)(0?[1-9]|1[0-2])\/(20\d{2})(?!\d)/);
  if (slash) return { months: [monthKey(Number(slash[2]), Number(slash[1]) - 1)], partial: false };
  const found = [...raw.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/g)].map((m) => MONTHS.indexOf(m[1]));
  if (!found.length) return null;
  const yearMatch = raw.match(/(?<!\d)(20\d{2})(?!\d)/);
  const [refYear, refMonth] = referenceMonth.split("-").map(Number);
  const yearFor = (index: number) => {
    if (yearMatch) return Number(yearMatch[1]);
    return index + 1 <= refMonth ? refYear : refYear - 1; // most recent such month
  };
  const first = monthKey(yearFor(found[0]), found[0]);
  const last = found.length > 1 ? monthKey(yearFor(found[found.length - 1]), found[found.length - 1]) : first;
  const months: string[] = [];
  for (let key = first, guard = 0; guard < 24; key = shiftMonth(key, 1), guard++) {
    months.push(key);
    if (key === last) break;
  }
  const dayRange = /\b\d{1,2}\s*[-–]\s*\d{1,2}\b/.test(raw.replace(/20\d{2}/g, ""));
  return { months, partial: found.length === 1 && dayRange };
}

/** The period part of a display name like "Voss Events Inc - Bank Statement - July.pdf". */
export function periodFromDisplayName(displayName: string | null | undefined): string | null {
  const stem = String(displayName ?? "").replace(/\.[a-z0-9]{2,5}$/i, "");
  const parts = stem.split(" - ");
  return parts.length >= 2 ? parts[parts.length - 1] : null;
}

export type StatementInput = {
  documentId: string;
  displayName: string | null;
  filename: string | null;
  txFirst: string | null;
  txLast: string | null;
};

export type Coverage = {
  requiredMonths: number;
  expectedMonths: string[];
  coveredMonths: string[];
  missingMonths: string[];
  currentMonthPartial: boolean;
  undatedStatements: number;
  statements: number;
  summary: string;
};

function spanForStatement(s: StatementInput, referenceMonth: string): MonthSpan | null {
  if (s.txFirst && s.txLast) {
    const first = s.txFirst.slice(0, 7);
    const last = s.txLast.slice(0, 7);
    const months: string[] = [];
    for (let key = first, guard = 0; guard < 24; key = shiftMonth(key, 1), guard++) {
      months.push(key);
      if (key >= last) break;
    }
    return { months, partial: false };
  }
  const typed = parsePeriodText(periodFromDisplayName(s.displayName), referenceMonth);
  if (typed) return typed;
  const fromFile = periodFromFilename(s.filename, true);
  return fromFile && /^20\d{2}-\d{2}$/.test(fromFile) ? { months: [fromFile], partial: false } : null;
}

function rangeText(months: string[]): string {
  if (!months.length) return "";
  const groups: string[][] = [];
  for (const m of months) {
    const g = groups[groups.length - 1];
    if (g && shiftMonth(g[g.length - 1], 1) === m) g.push(m); else groups.push([m]);
  }
  return groups.map((g) => (g.length === 1 ? monthLabel(g[0]) : `${monthLabel(g[0])} – ${monthLabel(g[g.length - 1])}`)).join(", ");
}

export function computeCoverage(statements: StatementInput[], referenceMonth: string, requiredMonths = DEFAULT_REQUIRED_MONTHS): Coverage {
  const covered = new Set<string>();
  let currentMonthPartial = false;
  let undated = 0;
  for (const s of statements) {
    const span = spanForStatement(s, referenceMonth);
    if (!span) { undated += 1; continue; }
    for (const m of span.months) {
      if (m === referenceMonth) currentMonthPartial = true;
      else covered.add(m);
    }
  }
  const expected = Array.from({ length: requiredMonths }, (_, i) => shiftMonth(referenceMonth, -(requiredMonths - i)));
  const missing = expected.filter((m) => !covered.has(m));
  const coveredSorted = [...covered].sort();
  const parts: string[] = [];
  if (coveredSorted.length) parts.push(rangeText(coveredSorted));
  if (currentMonthPartial) parts.push(`${monthLabel(referenceMonth)} (partial)`);
  parts.push(`${requiredMonths - missing.length} of ${requiredMonths} months`);
  parts.push(missing.length ? `missing ${rangeText(missing)}` : "no gaps");
  if (undated) parts.push(`${undated} statement${undated === 1 ? "" : "s"} not dated`);
  return {
    requiredMonths,
    expectedMonths: expected,
    coveredMonths: coveredSorted,
    missingMonths: missing,
    currentMonthPartial,
    undatedStatements: undated,
    statements: statements.length,
    summary: parts.join(" · "),
  };
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
const defaultQuery: Query = (sql, params) => pool.query(sql, params as any[]);

export async function bankCoverageForApplication(applicationId: string, now = new Date(), query: Query = defaultQuery): Promise<Coverage | null> {
  const docs = await query(
    `SELECT d.id::text AS id, COALESCE(d.document_type, d.category) AS category, d.filename, d.display_name,
            (SELECT MIN(t.transaction_date)::text FROM banking_transactions t WHERE t.document_id::text = d.id::text) AS tx_first,
            (SELECT MAX(t.transaction_date)::text FROM banking_transactions t WHERE t.document_id::text = d.id::text) AS tx_last
       FROM documents d
      WHERE d.application_id::text = ($1)::text
        AND COALESCE(d.status, '') <> 'rejected'`,
    [applicationId],
  );
  const statements = (docs.rows ?? []).filter((r) => resolveExpectedDocumentKey(r.category) === "bank_statements_6_months");
  if (!statements.length) return null;
  const monthsWanted = (() => {
    const label = statements.map((r) => String(r.category ?? "")).find((c) => /\d+\s*months?/i.test(c));
    const n = label ? Number(label.match(/(\d+)\s*months?/i)![1]) : DEFAULT_REQUIRED_MONTHS;
    return n > 0 && n <= 24 ? n : DEFAULT_REQUIRED_MONTHS;
  })();
  const referenceMonth = monthKey(now.getUTCFullYear(), now.getUTCMonth());
  return computeCoverage(
    statements.map((r) => ({ documentId: r.id, displayName: r.display_name ?? null, filename: r.filename ?? null, txFirst: r.tx_first ?? null, txLast: r.tx_last ?? null })),
    referenceMonth,
    monthsWanted,
  );
}
