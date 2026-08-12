// BF_SERVER_TX_INSIGHTS_v51
// Deterministic underwriting signals over already-extracted transactions.

import { isNsfDescription } from "./statementIntegrity.js";

export type InsightTransaction = { date: string | null; description: string | null; amount?: number };
export type UnusualTransaction = {
  date: string | null;
  description: string | null;
  amount: number;
  type: "large_deposit" | "large_withdrawal" | "round_sum" | "nsf" | "repeated_amount";
  reason: string;
};
export type VendorTotal = { vendor: string; total: number; count: number };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function medianAbsoluteDeviation(values: number[], mid: number): number {
  return values.length === 0 ? 0 : median(values.map((value) => Math.abs(value - mid)));
}

const OUTLIER_MAD_MULTIPLE = 6;
const MIN_SAMPLE = 8;
const ROUND_SUM_MIN = 10_000;
const MAX_FLAGS = 25;

function isRoundSum(amount: number): boolean {
  const absoluteAmount = Math.abs(amount);
  return absoluteAmount >= ROUND_SUM_MIN && absoluteAmount % 1000 === 0;
}

export function detectUnusualTransactions(transactions: InsightTransaction[]): UnusualTransaction[] {
  const usable = transactions.filter(
    (transaction): transaction is InsightTransaction & { amount: number } =>
      typeof transaction.amount === "number" && Number.isFinite(transaction.amount),
  );
  if (usable.length === 0) return [];

  const deposits = usable.filter(({ amount }) => amount > 0).map(({ amount }) => amount);
  const withdrawals = usable.filter(({ amount }) => amount < 0).map(({ amount }) => Math.abs(amount));
  const depositMedian = median(deposits);
  const depositMad = medianAbsoluteDeviation(deposits, depositMedian);
  const withdrawalMedian = median(withdrawals);
  const withdrawalMad = medianAbsoluteDeviation(withdrawals, withdrawalMedian);

  const sameDayAmounts = new Map<string, number>();
  for (const transaction of usable) {
    const key = `${transaction.date ?? ""}|${transaction.amount.toFixed(2)}`;
    sameDayAmounts.set(key, (sameDayAmounts.get(key) ?? 0) + 1);
  }

  const results: UnusualTransaction[] = [];
  const seen = new Set<InsightTransaction>();
  const push = (
    transaction: InsightTransaction & { amount: number },
    type: UnusualTransaction["type"],
    reason: string,
  ) => {
    if (seen.has(transaction)) return;
    seen.add(transaction);
    results.push({
      date: transaction.date,
      description: transaction.description,
      amount: transaction.amount,
      type,
      reason,
    });
  };

  for (const transaction of usable) {
    if (isNsfDescription(transaction.description)) {
      push(transaction, "nsf", "Non-sufficient funds or returned item");
      continue;
    }
    const absoluteAmount = Math.abs(transaction.amount);
    if (
      transaction.amount > 0 && deposits.length >= MIN_SAMPLE && depositMad > 0 &&
      absoluteAmount > depositMedian + OUTLIER_MAD_MULTIPLE * depositMad
    ) {
      push(transaction, "large_deposit", `Deposit far above the typical deposit of ${depositMedian.toFixed(2)}`);
      continue;
    }
    if (
      transaction.amount < 0 && withdrawals.length >= MIN_SAMPLE && withdrawalMad > 0 &&
      absoluteAmount > withdrawalMedian + OUTLIER_MAD_MULTIPLE * withdrawalMad
    ) {
      push(transaction, "large_withdrawal", `Withdrawal far above the typical withdrawal of ${withdrawalMedian.toFixed(2)}`);
      continue;
    }
    const key = `${transaction.date ?? ""}|${transaction.amount.toFixed(2)}`;
    if ((sameDayAmounts.get(key) ?? 0) > 1) {
      push(transaction, "repeated_amount", "Identical amount posted more than once on the same day");
      continue;
    }
    if (isRoundSum(transaction.amount)) push(transaction, "round_sum", "Round-figure amount");
  }

  return results.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, MAX_FLAGS);
}

const TYPE_PREFIXES = [
  /^pre[-\s]?authorized\s+payment[,:\s]*/i,
  /^direct\s+deposit[,:\s]*/i,
  /^incoming\s+wire\s+payment[,:\s]*/i,
  /^outgoing\s+wire\s+payment[,:\s]*/i,
  /^online\s+transfer[,:\s]*/i,
  /^interac\s+e-?transfer(\s+(sent|received))?[,:\s]*/i,
  /^us\s*\$?\s*transfer[,:\s]*/i,
  /^cheque[,:\s]*/i,
  /^bill\s+payment[,:\s]*/i,
  /^point\s+of\s+sale[,:\s]*/i,
];

export function normalizeVendor(description: string | null | undefined): string | null {
  let normalized = String(description ?? "").trim();
  if (!normalized) return null;
  for (const prefix of TYPE_PREFIXES) normalized = normalized.replace(prefix, "");
  normalized = normalized
    .replace(/\bno\.?\s*\d+\b/gi, " ")
    .replace(/\b(tf|ref|inv(oice)?)\s*#?\s*[\w-]*\d[\w-]*/gi, " ")
    .replace(/\bat\s*\d+\.\d+\b/gi, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/[^\w&/. -]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s/,.-]+$/g, "")
    .trim();
  return normalized.length < 2 ? null : normalized.toUpperCase();
}

export function aggregateVendors(transactions: InsightTransaction[], limit = 10): VendorTotal[] {
  const totals = new Map<string, { total: number; count: number }>();
  for (const transaction of transactions) {
    if (typeof transaction.amount !== "number" || !Number.isFinite(transaction.amount) || transaction.amount >= 0) continue;
    const vendor = normalizeVendor(transaction.description);
    if (!vendor) continue;
    const current = totals.get(vendor) ?? { total: 0, count: 0 };
    current.total += Math.abs(transaction.amount);
    current.count += 1;
    totals.set(vendor, current);
  }
  return [...totals.entries()]
    .map(([vendor, value]) => ({ vendor, total: Math.round(value.total * 100) / 100, count: value.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
