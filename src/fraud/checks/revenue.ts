// BF_SERVER_v846_FRAUD - check 5: the revenue the business reports (tax return, financial statements, the application)
// against the money actually deposited, annualised from the bank statements.
//
// Tolerance: revenue up to 40% above deposits is accepted without comment (cash sales, a second account, timing of
// receivables). Above 40% is amber, more than double is red. Deposits far above revenue (3x+) are amber only:
// loans, owner top-ups and transfers between accounts all land as deposits.
import { notApplicable, result, type CheckResult, type Reason } from "../types.js";

export type RevenueClaim = { source: "tax_return" | "financials" | "application"; label: string; min: number; max: number; period?: string | null };

export const UPPER_OK = 1.4;
export const UPPER_RED = 2.0;
export const LOWER_AMBER = 1 / 3;

const money = (n: number) => `$${Math.round(n).toLocaleString("en-CA")}`;
const SOURCE: Record<RevenueClaim["source"], string> = { tax_return: "tax return", financials: "financial statements", application: "application" };

export function evaluateRevenue(claims: RevenueClaim[], deposits: { monthlyAverage: number | null; months: number | null }): CheckResult {
  if (!deposits.monthlyAverage || !deposits.months || deposits.months < 2) {
    return notApplicable("Bank deposits are not available for at least two months yet, so revenue could not be compared.");
  }
  if (!claims.length) return notApplicable("No revenue figure was found on the tax return, financial statements or application.");
  const annual = deposits.monthlyAverage * 12;
  const reasons: Reason[] = [];
  const ratios: Array<{ source: string; ratio: number }> = [];
  for (const c of claims) {
    const high = c.max / annual;
    const low = c.min / annual;
    ratios.push({ source: c.source, ratio: Math.round(high * 100) / 100 });
    const claimText = c.min === c.max ? money(c.max) : `${money(c.min)}-${money(c.max)}`;
    const where = `${SOURCE[c.source]}${c.period ? ` (${c.period})` : ""}`;
    if (low > UPPER_RED) {
      reasons.push({ code: `revenue_over_${c.source}`, severity: "red", text: `The ${where} reports ${claimText} in revenue, more than double the ${money(annual)} a year deposited in the bank.` });
    } else if (low > UPPER_OK) {
      reasons.push({ code: `revenue_over_${c.source}`, severity: "amber", text: `The ${where} reports ${claimText} in revenue, ${Math.round((low - 1) * 100)}% above the ${money(annual)} a year deposited. Ask about other accounts or cash sales.` });
    } else if (high < LOWER_AMBER) {
      reasons.push({ code: `deposits_over_${c.source}`, severity: "amber", text: `Deposits of about ${money(annual)} a year are more than three times the ${claimText} revenue on the ${where}. Loans or transfers between accounts can explain this - worth asking.` });
    }
  }
  if (!reasons.length) reasons.push({ code: "revenue_consistent", severity: "info", text: `Reported revenue is in line with about ${money(annual)} a year of deposits (we allow up to 40% for cash sales, other accounts and timing).` });
  return result(reasons, { annual_deposits: Math.round(annual), months: deposits.months, ratios });
}
