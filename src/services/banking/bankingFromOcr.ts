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

export type BankTransaction = {
  date: string | null;
  description: string | null;
  amount: number | null;
  balance: number | null;
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

function parseIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(DATE_RE);
  if (!m) return null;
  const mm = (m[1] ?? "").padStart(2, "0");
  const dd = (m[2] ?? "").padStart(2, "0");
  let yyyy = m[3] ?? "";
  if (!yyyy) {
    yyyy = String(new Date().getUTCFullYear());
  } else if (yyyy.length === 2) {
    const yy = Number(yyyy);
    yyyy = yy >= 70 ? `19${yyyy}` : `20${yyyy}`;
  }
  const dt = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function extractTransactionsFromTables(doc: RawOcrDocument): BankTransaction[] {
  const out: BankTransaction[] = [];
  for (const page of doc.pages ?? []) {
    for (const t of page.tables ?? []) {
      const rows = t.rows ?? [];
      if (rows.length < 2) continue;
      const header = (rows[0] ?? []).map((c) => (c?.text ?? "").trim().toLowerCase());
      const dateIdx = header.findIndex((h) => h === "date" || h === "posted" || h === "trans date");
      const descIdx = header.findIndex((h) => h.includes("desc") || h === "details" || h === "transaction");
      const amtIdx = header.findIndex((h) => h === "amount" || h === "debit" || h === "credit" || h.includes("amt"));
      const balIdx = header.findIndex((h) => h.includes("balance"));
      if (dateIdx < 0 && descIdx < 0 && amtIdx < 0) continue;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i] ?? [];
        const cell = (idx: number) => (idx >= 0 ? (r[idx]?.text ?? null) : null);
        const tx: BankTransaction = {
          date: parseIsoDate(cell(dateIdx)),
          description: (cell(descIdx) ?? "").trim() || null,
          amount: parseAmount(cell(amtIdx)),
          balance: parseAmount(cell(balIdx)),
        };
        if (tx.date || tx.description || tx.amount !== null) out.push(tx);
      }
    }
  }
  return out;
}

export function buildBankingFromOcr(doc: RawOcrDocument): { transactions: BankTransaction[] } {
  return { transactions: extractTransactionsFromTables(doc) };
}
