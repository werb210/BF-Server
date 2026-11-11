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
    // v941: "Closing balance INTEREST PAID YEAR TO DATE" is a summary line, not the closing balance.
    if (CLOSING.test(d) && /interest|year\s*to\s*date|\bytd\b|limit|available/i.test(d)) continue;
    if (CLOSING.test(d)) { const v = isNum(r.balance) ? r.balance : isNum(r.amount) ? r.amount : null; if (v != null) closing = v; continue; }
    if (isNum(r.amount)) tx.push(r);
  }
  // BF_SERVER_v941_STATEMENT_MATH_FIXES (Todd's screenshot review, Nov 11 2026): every statement on one file showed
  // "Opening balance $0.00 ..." and a fraud score of 100. An opening balance of exactly $0.00 is usually the scanner
  // reading an empty cell; trust it only when the first printed running balance agrees with starting from zero.
  if (opening === 0) {
    const firstWithBal = tx.findIndex((r) => isNum(r.balance));
    if (firstWithBal >= 0) {
      const upTo = tx.slice(0, firstWithBal + 1).reduce((a, r) => a + (r.amount as number), 0);
      if (Math.abs(Math.round(upTo * 100) / 100 - (tx[firstWithBal]!.balance as number)) > TOLERANCE) opening = null;
    }
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
    let carry: number = r.balance; // the balance the next row continues from
    if (prev != null) {
      checked++;
      const expected = Math.round((prev + pending) * 100) / 100;
      if (Math.abs(expected - r.balance) > TOLERANCE) {
        // A withdrawal read as a deposit (or the reverse) is a reading problem, not an edit: try the other sign.
        const flipped = Math.round((prev - pending) * 100) / 100;
        const singleFlip = Math.round((prev + pending - 2 * (r.amount as number)) * 100) / 100;
        // v941: an overdrawn balance printed without its minus sign ("2,942.03 OD" read as 2,942.03) is also a reading
        // problem: the same figure with the other sign is not an edit.
        const balanceSignLost = Math.abs(Math.abs(expected) - Math.abs(r.balance)) <= TOLERANCE;
        if (balanceSignLost) carry = expected; // carry on from the real (signed) balance
        if (balanceSignLost || Math.abs(flipped - r.balance) <= TOLERANCE || Math.abs(singleFlip - r.balance) <= TOLERANCE) signAmbiguous++;
        else {
          breaks++;
          if (firstBreaks.length < 5) firstBreaks.push({ date: r.date, expected, shown: r.balance });
        }
      }
    }
    prev = carry;
    pending = 0;
  }

  const reasons: Reason[] = [];
  let totalMismatch: number | null = null;
  if (opening != null && closing != null) {
    const sum = tx.reduce((a, r) => a + (r.amount as number), 0);
    const expectedClose = Math.round((opening + sum) * 100) / 100;
    if (Math.abs(expectedClose - closing) > TOLERANCE) {
      totalMismatch = Math.round((closing - expectedClose) * 100) / 100;
      // v941: a gap bigger than every transaction on the statement put together cannot come from an edited amount;
      // the opening or closing figure was misread (e.g. a credit limit read as the closing balance).
      const turnover = tx.reduce((a, r) => a + Math.abs(r.amount as number), 0);
      if (Math.abs(totalMismatch) > turnover && turnover > 0) {
        reasons.push({ code: "totals_unreadable", severity: "info", text: `The opening or closing balance could not be read reliably (the gap of ${money(totalMismatch)} is larger than all the transactions on the statement), so the totals were not checked.` });
      } else reasons.push({ code: "totals_mismatch", severity: "red", text: `Opening balance ${money(opening)} plus the listed transactions comes to ${money(expectedClose)}, but the statement's closing balance is ${money(closing)} (off by ${money(totalMismatch)}).` });
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
