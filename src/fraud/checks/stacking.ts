// BF_SERVER_v846_FRAUD - check 11: loan stacking. Merchant cash advances and online lenders show up in bank data as a
// lump-sum deposit from the funder followed by daily or weekly debits of the same amount. Undisclosed ones mean the
// business is already carrying payments the application does not mention.
import { notApplicable, result, type CheckResult, type Reason } from "../types.js";

export type BankLine = { date: string; description: string | null; amount: number };

/** Funders and MCA processors seen on Canadian and US statements. Matched as whole words, case-insensitive. */
export const FUNDERS = [
  "ondeck", "on deck capital", "merchant growth", "thinking capital", "iou financial", "journey capital", "lendified", "clearco",
  "clearbanc", "shopify capital", "square capital", "stripe capital", "paypal working capital", "amazon lending", "kabbage",
  "bluevine", "fundbox", "credibly", "rapid finance", "yellowstone capital", "libertas", "forward financing", "everest business",
  "pearl capital", "mulligan funding", "greenbox", "cfg merchant", "fora financial", "national funding", "can capital",
  "headway capital", "lendini", "reliant funding", "kapitus", "itria", "4front", "fundthrough", "merchant advance",
  "merchant cash advance", "mca", "capital advance", "business advance", "daily ach", "funding llc", "funding inc",
  "advance repay", "lendio", "uplift capital", "smart business funding", "momentum funding",
  "gocapital", "go capital", "blue vine", "parafin", "wayflyer", "youlend", "liberis", "sbg funding",
];

const FUNDER_RE = new RegExp(`\\b(${FUNDERS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*")).join("|")})\\b`, "i");

const day = (iso: string) => Math.floor(new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime() / 86_400_000);
const money = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-CA")}`;

export type StackingFinding = { funder: string; kind: "advance" | "repayments"; count: number; total: number; cadence?: "daily" | "weekly"; last: string };

/** Repeated equal debits on a daily (business days) or weekly rhythm, at least 8 of them. */
function repeatedDebits(lines: BankLine[]): Array<{ amount: number; count: number; cadence: "daily" | "weekly"; last: string; description: string }> {
  const groups = new Map<string, BankLine[]>();
  for (const l of lines) {
    if (l.amount >= 0 || Math.abs(l.amount) < 50) continue;
    const key = Math.abs(l.amount).toFixed(2);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const out: Array<{ amount: number; count: number; cadence: "daily" | "weekly"; last: string; description: string }> = [];
  for (const [amt, ls] of groups) {
    if (ls.length < 8) continue;
    const days = [...new Set(ls.map((l) => day(l.date)))].sort((a, b) => a - b);
    const gaps = days.slice(1).map((d, i) => d - days[i]!);
    const daily = gaps.filter((g) => g >= 1 && g <= 3).length / Math.max(1, gaps.length);
    const weekly = gaps.filter((g) => g >= 6 && g <= 8).length / Math.max(1, gaps.length);
    const cadence = daily >= 0.7 ? "daily" : weekly >= 0.7 ? "weekly" : null;
    // Weekly payroll and rent-like amounts are common; only daily rhythm or a funder-looking description counts.
    const desc = ls[ls.length - 1]!.description ?? "";
    if (cadence === "daily" || (cadence === "weekly" && FUNDER_RE.test(desc))) {
      out.push({ amount: Number(amt), count: ls.length, cadence, last: ls.map((l) => l.date).sort().at(-1)!, description: desc });
    }
  }
  return out;
}

export function detectStacking(lines: BankLine[], disclosedDebtText: string): CheckResult {
  if (!lines.length) return notApplicable("No bank transactions are available yet.");
  const findings: StackingFinding[] = [];
  const advances = lines.filter((l) => l.amount >= 5_000 && FUNDER_RE.test(l.description ?? ""));
  for (const a of advances) {
    const funder = (a.description ?? "").match(FUNDER_RE)?.[1] ?? "a funder";
    findings.push({ funder, kind: "advance", count: 1, total: a.amount, last: a.date });
  }
  const named = new Map<string, BankLine[]>();
  for (const l of lines) {
    if (l.amount >= 0) continue;
    const m = (l.description ?? "").match(FUNDER_RE);
    if (m) named.set(m[1]!.toLowerCase(), [...(named.get(m[1]!.toLowerCase()) ?? []), l]);
  }
  for (const [funder, ls] of named) {
    if (ls.length >= 3) findings.push({ funder, kind: "repayments", count: ls.length, total: ls.reduce((s, l) => s + Math.abs(l.amount), 0), last: ls.map((l) => l.date).sort().at(-1)! });
  }
  for (const r of repeatedDebits(lines)) {
    const funder = (r.description.match(FUNDER_RE)?.[1] ?? "").toLowerCase();
    if (funder && named.has(funder)) continue; // already counted above
    findings.push({ funder: funder || "an unnamed payee", kind: "repayments", count: r.count, total: r.amount * r.count, cadence: r.cadence, last: r.last });
  }
  if (!findings.length) return result([{ code: "no_stacking", severity: "info", text: "No advances or daily/weekly repayments to other lenders were found in the bank data." }]);
  const disclosed = disclosedDebtText.trim().length > 0 && !/^(no|none|n\/a|0|false|\[\]|\{\})$/i.test(disclosedDebtText.trim());
  const reasons: Reason[] = findings.slice(0, 6).map((f) => {
    const what = f.kind === "advance"
      ? `A deposit of ${money(f.total)} from ${f.funder} on ${f.last} looks like a recent advance`
      : `${f.count} ${f.cadence ?? "repeated"} payments to ${f.funder} (${money(f.total)} in total, last on ${f.last}) look like advance repayments`;
    return { code: `stacking_${f.kind}`, severity: disclosed ? "amber" : "red", text: `${what}${disclosed ? ". Check it against the debts the applicant listed." : ", and no existing debt was disclosed on the application."}` } as Reason;
  });
  return result(reasons, { findings: findings.length, disclosed });
}
