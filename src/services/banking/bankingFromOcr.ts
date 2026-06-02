export type RawOcrTable = {
  rows?: Array<Array<{ text?: string | null }>>;
};

export type RawOcrPage = {
  page_number?: number;
  tables?: RawOcrTable[];
  text?: string | null;
  lines?: Array<{ text?: string | null }>;
};

export type RawOcrDocument = {
  pages?: RawOcrPage[];
  fields?: Record<string, { value?: unknown; valueString?: string | null; valueNumber?: number | null }>;
};

// BF_SERVER_v71_BLOCK_1_4_FIX — widened to be assignable to the legacy
// worker row shape (balance? / credit? / debit? / type?), which doesn't
// allow null. We use undefined for "absent" instead.
export type BankTransaction = {
  date: string | null;
  description: string | null;
  amount?: number;
  balance?: number;
};

const NUMERIC_RE = /-?\$?\(?-?[\d,]+\.\d{2}\)?/;
const DATE_RE = /\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/;

function parseAmount(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(NUMERIC_RE);
  if (!m) return null;
  let raw = m[0] ?? "";
  const negParen = raw.startsWith("(") && raw.endsWith(")");
  raw = raw.replace(/[()$,\s]/g, "");
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  return negParen ? -Math.abs(n) : n;
}

// BF_SERVER_BLOCK_v721 — month-name dates ("Nov 16", "Nov16", "November 16")
// are used by Canadian (ATB/RBC/TD/BMO/etc.) statements. The numeric DATE_RE
// never matched them, so every transaction date came back null and was dropped
// -> empty banking analysis (and, downstream, almost no lender matches). Parse
// month-name dates too, inferring the year from the statement period (with
// Dec->Jan rollover when the statement month is known).
const MONTH_NAMES_v721: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_NAME_DATE_RE = /\b([A-Za-z]{3,9})\.?\s*([0-3]?\d)\b/;

function parseIsoDate(s: string | null | undefined, statementYear: number | null = null, statementMonth: number | null = null): string | null {
  if (!s) return null;
  const m = s.match(DATE_RE);
  if (m) {
    const mm = (m[1] ?? "").padStart(2, "0");
    const dd = (m[2] ?? "").padStart(2, "0");
    let yyyy = m[3] ?? "";
    if (!yyyy) {
      // Year missing in source — use the statement period year if provided
      yyyy = statementYear !== null ? String(statementYear) : String(new Date().getUTCFullYear());
    } else if (yyyy.length === 2) {
      const yy = Number(yyyy);
      yyyy = yy >= 70 ? `19${yyyy}` : `20${yyyy}`;
    }
    const dt = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
    if (Number.isNaN(dt.getTime())) return null;
    return `${yyyy}-${mm}-${dd}`;
  }
  // Month-name date (Canadian statements): "Nov 16", "Nov16", "November 16".
  const mn = s.match(MONTH_NAME_DATE_RE);
  if (mn) {
    const mon = MONTH_NAMES_v721[(mn[1] ?? "").slice(0, 3).toLowerCase()];
    if (mon) {
      const dd = (mn[2] ?? "").padStart(2, "0");
      let year = statementYear !== null ? statementYear : new Date().getUTCFullYear();
      // A transaction month later than the statement month belongs to the prior
      // year (e.g. December activity printed on a January/February statement).
      if (statementMonth !== null && mon > statementMonth) year -= 1;
      const mm = String(mon).padStart(2, "0");
      const dt = new Date(`${year}-${mm}-${dd}T00:00:00Z`);
      if (Number.isNaN(dt.getTime())) return null;
      return `${year}-${mm}-${dd}`;
    }
  }
  return null;
}

// Extract transactions from Azure DocIntel prebuilt-bankStatement.us structured fields.
// Schema (varies slightly by API version):
//   result.documents[].fields.Accounts.valueArray[].valueObject.Transactions.valueArray[]
//                                                  .valueObject.{Date, Description, DepositAmount, WithdrawalAmount, Amount, Balance}
// We also handle the legacy shape where Transactions live at the document level:
//   result.documents[].fields.Transactions.valueArray[]
export function extractTransactionsFromBankStatementModel(result: any): BankTransaction[] {
  const out: BankTransaction[] = [];
  const docs = Array.isArray(result?.documents) ? result.documents : [];
  for (const document of docs) {
    const fields = document?.fields ?? {};

    // Pattern A: Accounts[] containing Transactions[]
    const accounts = fields.Accounts?.valueArray ?? fields.Accounts?.values ?? [];
    for (const acc of accounts) {
      const accObj = acc?.valueObject ?? acc?.properties ?? acc ?? {};
      const txArr = accObj?.Transactions?.valueArray ?? accObj?.Transactions?.values ?? [];
      for (const t of txArr) pushTx(out, t);
    }

    // Pattern B: Transactions[] at the document level
    const docTx = fields.Transactions?.valueArray ?? fields.Transactions?.values ?? [];
    for (const t of docTx) pushTx(out, t);
  }
  return out;
}

function pushTx(out: BankTransaction[], rawTx: any): void {
  const obj = rawTx?.valueObject ?? rawTx?.properties ?? rawTx ?? {};
  // Date can be valueDate (ISO string), valueString, or content fallback
  const dateRaw =
    obj?.Date?.valueDate ??
    obj?.Date?.valueString ??
    obj?.Date?.content ??
    obj?.PostedDate?.valueDate ??
    obj?.PostedDate?.valueString ??
    null;
  let date: string | null = null;
  if (typeof dateRaw === "string") {
    // valueDate is already YYYY-MM-DD; valueString/content may be MM/DD/YYYY
    if (/^\d{4}-\d{2}-\d{2}/.test(dateRaw)) {
      date = dateRaw.slice(0, 10);
    } else {
      date = parseIsoDate(dateRaw);
    }
  }
  const description: string | null =
    obj?.Description?.valueString ??
    obj?.Description?.content ??
    obj?.Memo?.valueString ??
    obj?.Payee?.valueString ??
    null;
  // Pattern: separate DepositAmount + WithdrawalAmount → signed amount
  const deposit = numberOrNull(obj?.DepositAmount);
  const withdrawal = numberOrNull(obj?.WithdrawalAmount);
  let amount: number | undefined;
  if (deposit !== null && deposit !== 0) amount = deposit;
  else if (withdrawal !== null && withdrawal !== 0) amount = -Math.abs(withdrawal);
  else {
    // Pattern: single Amount field (signed)
    const single = numberOrNull(obj?.Amount);
    if (single !== null) amount = single;
  }
  const balance = numberOrNull(obj?.Balance) ?? numberOrNull(obj?.RunningBalance);
  if (!date && !description && amount === undefined) return;
  const tx: BankTransaction = { date, description };
  if (amount !== undefined) tx.amount = amount;
  if (balance !== null) tx.balance = balance;
  out.push(tx);
}

function numberOrNull(field: any): number | null {
  if (field === null || field === undefined) return null;
  if (typeof field === "number") return Number.isFinite(field) ? field : null;
  const v =
    field?.valueNumber ??
    field?.valueCurrency?.amount ??
    field?.value ??
    null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const parsed = parseAmount(v);
    return parsed;
  }
  // Fallback: parse from content string
  const content = field?.content;
  if (typeof content === "string") return parseAmount(content);
  return null;
}

function headerIndices(header: string[]): {
  detected: boolean;
  dateIdx: number;
  descIdx: number;
  amtIdx: number;
  debitIdx: number;
  creditIdx: number;
  balIdx: number;
} {
  const dateIdx = header.findIndex((h) =>
    /\b(date|posted|posting|trans|transaction|effective|activity)\b/.test(h)
  );
  const descIdx = header.findIndex((h) =>
    /\b(desc|detail|details|description|memo|payee|narrative|activity|type)\b/.test(h)
  );
  const debitIdx = header.findIndex((h) => /\b(debit|withdrawal|withdrawn|paid out)\b/.test(h));
  const creditIdx = header.findIndex((h) => /\b(credit|deposit|paid in)\b/.test(h));
  const amtIdx = header.findIndex((h) => /\b(amount|amt)\b/.test(h));
  const balIdx = header.findIndex((h) => /\b(balance|running balance)\b/.test(h));
  const detected = dateIdx >= 0 || descIdx >= 0 || amtIdx >= 0 || debitIdx >= 0 || creditIdx >= 0;
  return { detected, dateIdx, descIdx, amtIdx, debitIdx, creditIdx, balIdx };
}

// Fallback extractor for layout-model output. Carries header across pages,
// handles split debit/credit columns, broader header synonyms,
// and accepts an optional statementYear hint.
export function extractTransactionsFromTables(
  doc: RawOcrDocument,
  opts?: { statementYear?: number | null; statementMonth?: number | null },
): BankTransaction[] {
  const out: BankTransaction[] = [];
  let carryHeader: ReturnType<typeof headerIndices> | null = null;
  for (const page of doc.pages ?? []) {
    for (const t of page.tables ?? []) {
      const rows = t.rows ?? [];
      if (rows.length === 0) continue;
      const firstRow = (rows[0] ?? []).map((c) => (c?.text ?? "").trim().toLowerCase());
      const tryHeader = headerIndices(firstRow);
      const header = tryHeader.detected ? tryHeader : carryHeader;
      const startRow = tryHeader.detected ? 1 : 0;
      if (!header) continue;
      if (tryHeader.detected) carryHeader = tryHeader;
      for (let i = startRow; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const cell = (idx: number) => (idx >= 0 ? (r[idx]?.text ?? null) : null);
        const dateCell = cell(header.dateIdx);
        const descCell = cell(header.descIdx);
        // Combine debit + credit into signed amount if both columns exist
        let amount: number | undefined;
        if (header.debitIdx >= 0 && header.creditIdx >= 0) {
          const debit = parseAmount(cell(header.debitIdx));
          const credit = parseAmount(cell(header.creditIdx));
          if (credit !== null && credit !== 0) amount = credit;
          else if (debit !== null && debit !== 0) amount = -Math.abs(debit);
        } else {
          const a = parseAmount(cell(header.amtIdx));
          if (a !== null) amount = a;
        }
        const balance = parseAmount(cell(header.balIdx));
        const date = parseIsoDate(dateCell, opts?.statementYear ?? null, opts?.statementMonth ?? null);
        const tx: BankTransaction = {
          date,
          description: (descCell ?? "").trim() || null,
        };
        if (amount !== undefined) tx.amount = amount;
        if (balance !== null) tx.balance = balance;
        if (tx.date || tx.description || tx.amount !== undefined) out.push(tx);
      }
    }
  }
  return out;
}

export function buildBankingFromOcr(doc: RawOcrDocument): { transactions: BankTransaction[] } {
  return { transactions: extractTransactionsFromTables(doc) };
}

// BF_SERVER_v71_BLOCK_1_4_FIX — adapter from BankTransaction to the legacy
// worker row shape. Worker expects { balance?, credit?, debit?, type? }
// with no null, so we split signed amount -> credit/debit and stringify
// nothing (numbers stay numeric).
export type LegacyBankRow = {
  balance?: number;
  credit?: number;
  debit?: number;
  type?: "credit" | "debit";
  date?: string;
  description?: string;
};

export function adaptToLegacyRow(tx: BankTransaction): LegacyBankRow {
  const out: LegacyBankRow = {};
  if (tx.date) out.date = tx.date;
  if (tx.description) out.description = tx.description;
  if (tx.balance !== undefined) out.balance = tx.balance;
  if (tx.amount !== undefined) {
    if (tx.amount >= 0) {
      out.credit = tx.amount;
      out.type = "credit";
    } else {
      out.debit = Math.abs(tx.amount);
      out.type = "debit";
    }
  }
  return out;
}

export function adaptAllToLegacyRows(transactions: BankTransaction[]): LegacyBankRow[] {
  return transactions.map(adaptToLegacyRow);
}
