// BF_SERVER_v846_FRAUD - check 2: bank-statement arithmetic. Walk the statement's transactions in the order they were
// printed, add each amount to the previous running balance and compare with the balance the statement shows; then
// check opening balance + all transactions = closing balance. An edited amount almost always breaks the chain,
// because the forger rarely recalculates every balance after it.
import { result, notApplicable, type CheckResult, type Reason } from "../types.js";

export type StatementRow = { date: string | null; description: string | null; amount?: number | null; balance?: number | null };

const OPENING = /^(?:opening|beginning|starting|balance brought forward|balance forward|previous)\s*balance\b|^balance\s+(?:brought\s+)?forward\b/i;
const CLOSING = /^(?:closing|ending|new|final)\s*balance\b|^balance\s+carried\s+forward\b/i;
const TOLERANCE = 0.011;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const money = (n: number) => `$${Math.abs(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${n < 0 ? " overdrawn" : ""}`;

export type MathDetails = {
  checked: number; breaks: number; sign_ambiguous: number; opening: number | null; closing: number | null;
  total_mismatch: number | null; first_breaks: Array<{ date: string | null; expected: number; shown: number }>;
};

export function checkStatementArithmetic(rows: StatementRow[]): CheckResult {
  let opening: number | null = null;
  let closing: number | null = null;
  const tx: StatementRow[] = [];
  for (const r of rows) {
    const d = String(r.description ?? "").trim();
    if (OPENING.test(d)) { const v = isNum(r.balance) ? r.balance : isNum(r.amount) ? r.amount : null; if (v != null && opening == null) opening = v; continue; }
    if (CLOSING.test(d)) { const v = isNum(r.balance) ? r.balance : isNum(r.amount) ? r.amount : null; if (v != null) closing = v; continue; }
    if (isNum(r.amount)) tx.push(r);
  }
  const withBalance = tx.filter((r) => isNum(r.balance)).length;
  if (tx.length === 0) return notApplicable("No transactions could be read from this statement, so the math could not be checked.");
  if (withBalance < 3 && (opening == null || closing == null)) {
    return notApplicable("This statement does not print running balances (or they could not be read), so only totals could be checked - and no opening and closing balance were found.");
  }

  let prev: number | null = opening;
  let pending = 0; // amounts since the last printed balance (statements often print one balance per day)
  let checked = 0, breaks = 0, signAmbiguous = 0;
  const firstBreaks: MathDetails["first_breaks"] = [];
  for (const r of tx) {
    pending += r.amount as number;
    if (!isNum(r.balance)) continue;
    if (prev != null) {
      checked++;
      const expected = Math.round((prev + pending) * 100) / 100;
      if (Math.abs(expected - r.balance) > TOLERANCE) {
        // A withdrawal read as a deposit (or the reverse) is a reading problem, not an edit: try the other sign.
        const flipped = Math.round((prev - pending) * 100) / 100;
        const singleFlip = Math.round((prev + pending - 2 * (r.amount as number)) * 100) / 100;
        if (Math.abs(flipped - r.balance) <= TOLERANCE || Math.abs(singleFlip - r.balance) <= TOLERANCE) signAmbiguous++;
        else {
          breaks++;
          if (firstBreaks.length < 5) firstBreaks.push({ date: r.date, expected, shown: r.balance });
        }
      }
    }
    prev = r.balance;
    pending = 0;
  }

  const reasons: Reason[] = [];
  let totalMismatch: number | null = null;
  if (opening != null && closing != null) {
    const sum = tx.reduce((a, r) => a + (r.amount as number), 0);
    const expectedClose = Math.round((opening + sum) * 100) / 100;
    if (Math.abs(expectedClose - closing) > TOLERANCE) {
      totalMismatch = Math.round((closing - expectedClose) * 100) / 100;
      reasons.push({ code: "totals_mismatch", severity: "red", text: `Opening balance ${money(opening)} plus the listed transactions comes to ${money(expectedClose)}, but the statement's closing balance is ${money(closing)} (off by ${money(totalMismatch)}).` });
    }
  }
  if (breaks > 0) {
    const ratio = checked ? breaks / checked : 1;
    const severity = breaks >= 2 || ratio > 0.1 ? "red" : "amber";
    const b = firstBreaks[0]!;
    reasons.push({ code: "balance_breaks", severity, text: `${breaks} running balance(s) do not add up${b.date ? ` - first on ${b.date}: expected ${money(b.expected)}, statement shows ${money(b.shown)}` : ""}. A badly scanned page can also cause this, so compare with the original.` });
  }
  if (signAmbiguous > 0 && breaks === 0) {
    reasons.push({ code: "sign_ambiguous", severity: "info", text: `${signAmbiguous} transaction(s) only add up with the sign reversed - usually a deposit read as a withdrawal by the scanner.` });
  }
  if (!reasons.some((r) => r.severity !== "info")) {
    reasons.push({ code: "math_ok", severity: "info", text: `All ${checked} running balance(s) add up${opening != null && closing != null ? ", and the opening and closing balances match the transactions" : ""}.` });
  }
  const details: MathDetails = { checked, breaks, sign_ambiguous: signAmbiguous, opening, closing, total_mismatch: totalMismatch, first_breaks: firstBreaks };
  return result(reasons, details as unknown as Record<string, unknown>);
}
