import { createHash } from "node:crypto";
import type { BankTransaction } from "./bankingFromOcr.js";

export type CurrencyCode = "CAD" | "USD" | "UNKNOWN";

export function isNsfDescription(description: string | null | undefined): boolean {
  const value = description?.normalize("NFKC") ?? "";
  return /(?:\bNSF\b|non[-\s]?sufficient funds?|insufficient funds?|returned (?:item|cheque|check|payment))/i.test(value);
}

export function isOpeningBalance(description: string | null | undefined): boolean {
  return /^(?:opening|beginning|balance brought forward|previous)\s+balance\b/i.test((description ?? "").trim());
}

export function detectStatementCurrency(text: string): CurrencyCode {
  const head = text.slice(0, 12_000);
  if (/(?:\bUSD\b|US\s*\$|U\.S\.\s*dollars?|United States Dollar)/i.test(head)) return "USD";
  if (/(?:\bCAD\b|CA\s*\$|C\s*\$|Canadian dollars?)/i.test(head)) return "CAD";
  return "UNKNOWN";
}

function canonicalTransaction(tx: BankTransaction): string {
  return [tx.date ?? "", (tx.description ?? "").toLowerCase().replace(/\s+/g, " ").trim(), tx.amount ?? "", tx.balance ?? ""].join("|");
}

/** A cover-page-independent fingerprint used to reject copied statement bodies. */
export function statementBodyFingerprint(text: string, transactions: BankTransaction[]): string {
  const transactionBody = transactions.map(canonicalTransaction).sort().join("\n");
  const normalizedBody = text
    .split(/\f|\n\s*page\s+\d+(?:\s+of\s+\d+)?\s*\n/i)
    .slice(1)
    .join("\n")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const stableBody = transactionBody || normalizedBody || text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(stableBody).digest("hex");
}

export function sanitizeTransactions(transactions: BankTransaction[]): BankTransaction[] {
  return transactions.filter((tx) => !isOpeningBalance(tx.description));
}
