// BF_SERVER_v906_BANKING_INSIGHTS - figures the Banking Analysis tab shows, worked out from the parsed transactions
// (banking_transactions) rather than only from banking_monthly_summaries.
//
// Why: the monthly table and the 6-month trend were empty on files whose totals were filled in. The analysis run
// deleted the monthly rows and the transactions first and re-created them only at the end, so while a re-run was in
// progress - or after a run that stopped part way - the tab showed the previous totals beside "No monthly data yet".
// The run now replaces them only once it has new transactions (bankingAnalysisPipeline.ts), and the tab falls back to
// these figures whenever the monthly rows are missing.

export type InsightTx = {
  document_id: string | null;
  transaction_date: string; // YYYY-MM-DD
  description: string | null;
  amount: number;
  balance_after: number | null;
  is_nsf: boolean;
};

export type MonthFigures = {
  month: string; // YYYY-MM-01
  deposits: number;
  withdrawals: number;
  net: number;
  endingBalance: number | null;
  averageBalance: number | null;
  nsfCount: number;
  daysNegative: number;
  depositCount: number;
  withdrawalCount: number;
};

export type PartyTotal = { name: string; total: number; count: number };
export type LenderPayment = { name: string; total: number; count: number; months: number; averagePayment: number };
export type StatementFigures = {
  document_id: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  deposits: number;
  withdrawals: number;
  transactionCount: number;
  nsfCount: number;
};

export type BankingInsights = {
  months: MonthFigures[];
  statements: StatementFigures[];
  nsfCount: number;
  daysNegative: number;
  topPayees: PartyTotal[];
  topPayors: PartyTotal[];
  lenderPayments: LenderPayment[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const toDay = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v ?? "").slice(0, 10);
};

// Lenders, merchant cash advance and equipment finance companies seen on Canadian and US statements, plus the generic
// words they use. A match is a hint for the broker to check, not a finding.
const LENDER_WORDS = [
  "loan", "lending", "capital", "funding", "finance", "financial", "advance", "mca", "lease", "leasing", "credit line",
  "loc pmt", "loan pmt", "loan payment",
];
const LENDER_NAMES = [
  "ondeck", "on deck", "kabbage", "bluevine", "fundbox", "credibly", "rapid finance", "libertas", "yellowstone",
  "merchant growth", "iou financial", "journey capital", "lendified", "thinking capital", "clearco", "clearbanc",
  "4 pillars", "fundthrough", "shopify capital", "square capital", "paypal working", "stripe capital", "amex merchant",
  "bdc", "business development bank", "rbc royal bank loan", "cibc loan", "td loan", "scotia loan", "bmo loan",
  "national leasing", "dll", "mitsubishi hc", "meridian onecap", "coast capital", "accord", "pathward",
];
// Words that look like lending but are not a lender payment (interest earned, account fees, deposits from a loan).
const NOT_LENDER = /(interest (earned|paid to you)|credit card payment received|e-?transfer|deposit|refund)/i;

/** A lender, MCA or lease payment, judging by the description (withdrawals only). */
export function looksLikeLenderPayment(description: string | null, amount: number): boolean {
  if (!(amount < 0)) return false;
  const d = String(description ?? "").toLowerCase();
  if (!d || NOT_LENDER.test(d)) return false;
  if (LENDER_NAMES.some((n) => d.includes(n))) return true;
  return LENDER_WORDS.some((w) => new RegExp(`(^|[^a-z])${w.replace(/ /g, "\\s+")}([^a-z]|$)`).test(d));
}

/** Groups "PAYMENT TO ACME CORP #4432 08/12" and "ACME CORP 0915" as one counterparty. */
export function counterparty(description: string | null): string {
  const d = String(description ?? "").toUpperCase()
    .replace(/\b(POS|PURCHASE|PAYMENT|PMT|PREAUTHORIZED|PRE-AUTHORIZED|PAD|DEBIT|CREDIT|MEMO|BILL|ONLINE|BANKING|TRANSFER|TFR|WITHDRAWAL|DEPOSIT|MISC|E-?TRANSFER|INTERAC|SEND|AUTODEPOSIT|TO|FROM)\b/g, " ")
    .replace(/[#*]?\d[\d\-/.:]*/g, " ")
    .replace(/[^A-Z&' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return d.split(" ").slice(0, 4).join(" ") || "Unnamed";
}

function topParties(list: InsightTx[], limit: number): PartyTotal[] {
  const by = new Map<string, PartyTotal>();
  for (const t of list) {
    const name = counterparty(t.description);
    const row = by.get(name) ?? { name, total: 0, count: 0 };
    row.total += Math.abs(t.amount);
    row.count += 1;
    by.set(name, row);
  }
  return [...by.values()].map((r) => ({ ...r, total: round2(r.total) })).sort((a, b) => b.total - a.total).slice(0, limit);
}

export function buildBankingInsights(raw: InsightTx[]): BankingInsights {
  const txs = raw
    .map((t) => ({ ...t, transaction_date: toDay(t.transaction_date), amount: Number(t.amount), balance_after: t.balance_after === null || t.balance_after === undefined ? null : Number(t.balance_after) }))
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t.transaction_date) && Number.isFinite(t.amount));
  // Keep the statement order within a day (the order the rows were read) - sort is stable.
  txs.sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));

  // Last balance seen on each day, per account (document), to count days below zero and average balances.
  const dayBalance = new Map<string, number>();
  for (const t of txs) if (t.balance_after !== null && Number.isFinite(t.balance_after)) dayBalance.set(`${t.document_id ?? ""}|${t.transaction_date}`, t.balance_after);
  const negativeDays = new Set<string>();
  for (const [k, v] of dayBalance) if (v < 0) negativeDays.add(k.split("|")[1]!);

  const months = new Map<string, MonthFigures & { balances: number[]; negative: Set<string> }>();
  for (const t of txs) {
    const key = `${t.transaction_date.slice(0, 7)}-01`;
    const m = months.get(key) ?? { month: key, deposits: 0, withdrawals: 0, net: 0, endingBalance: null, averageBalance: null, nsfCount: 0, daysNegative: 0, depositCount: 0, withdrawalCount: 0, balances: [], negative: new Set<string>() };
    if (t.amount > 0) { m.deposits += t.amount; m.depositCount += 1; } else if (t.amount < 0) { m.withdrawals += -t.amount; m.withdrawalCount += 1; }
    m.net += t.amount;
    if (t.is_nsf) m.nsfCount += 1;
    if (t.balance_after !== null && Number.isFinite(t.balance_after)) m.endingBalance = t.balance_after;
    months.set(key, m);
  }
  for (const [k, v] of dayBalance) {
    const day = k.split("|")[1]!;
    const m = months.get(`${day.slice(0, 7)}-01`);
    if (!m) continue;
    m.balances.push(v);
    if (v < 0) m.negative.add(day);
  }
  const monthList: MonthFigures[] = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(({ balances, negative, ...m }) => ({
    ...m,
    deposits: round2(m.deposits), withdrawals: round2(m.withdrawals), net: round2(m.net),
    averageBalance: balances.length ? round2(balances.reduce((s, b) => s + b, 0) / balances.length) : null,
    daysNegative: negative.size,
  }));

  const byDoc = new Map<string, InsightTx[]>();
  for (const t of txs) {
    const id = t.document_id ?? "";
    if (!byDoc.has(id)) byDoc.set(id, []);
    byDoc.get(id)!.push(t);
  }
  const statements: StatementFigures[] = [...byDoc.entries()].filter(([id]) => id).map(([document_id, list]) => {
    const withBal = list.filter((t) => t.balance_after !== null && Number.isFinite(t.balance_after));
    const first = withBal[0];
    const last = withBal[withBal.length - 1];
    return {
      document_id,
      periodStart: list[0]?.transaction_date ?? null,
      periodEnd: list[list.length - 1]?.transaction_date ?? null,
      openingBalance: first ? round2((first.balance_after as number) - first.amount) : null,
      closingBalance: last ? round2(last.balance_after as number) : null,
      deposits: round2(list.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0)),
      withdrawals: round2(list.filter((t) => t.amount < 0).reduce((s, t) => s - t.amount, 0)),
      transactionCount: list.length,
      nsfCount: list.filter((t) => t.is_nsf).length,
    };
  });

  const lenderBy = new Map<string, { name: string; total: number; count: number; months: Set<string> }>();
  for (const t of txs) {
    if (!looksLikeLenderPayment(t.description, t.amount)) continue;
    const name = counterparty(t.description);
    const row = lenderBy.get(name) ?? { name, total: 0, count: 0, months: new Set<string>() };
    row.total += -t.amount;
    row.count += 1;
    row.months.add(t.transaction_date.slice(0, 7));
    lenderBy.set(name, row);
  }
  const lenderPayments: LenderPayment[] = [...lenderBy.values()]
    .map((r) => ({ name: r.name, total: round2(r.total), count: r.count, months: r.months.size, averagePayment: round2(r.total / r.count) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 15);

  return {
    months: monthList,
    statements,
    nsfCount: txs.filter((t) => t.is_nsf).length,
    daysNegative: negativeDays.size,
    topPayees: topParties(txs.filter((t) => t.amount < 0), 10),
    topPayors: topParties(txs.filter((t) => t.amount > 0), 10),
    lenderPayments,
  };
}
