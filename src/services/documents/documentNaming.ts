// BF_SERVER_RENAME_ON_ACCEPT_v264
// "Business - Document type - Period.ext", suggested when staff accept a
// document. Staff can edit it. Used in the portal and on lender packages; the
// applicant keeps seeing the filename they uploaded.
import { pool } from "../../db.js";
import { resolveExpectedDocumentKey } from "./classifyDocument.js";

const KEY_LABELS: Record<string, string> = {
  bank_statements_6_months: "Bank Statement",
  tax_returns: "Tax Return",
  financial_statements: "Financial Statements",
  void_cheque: "Void Cheque",
  government_id: "Government ID",
  articles_of_incorporation: "Articles of Incorporation",
  accounts_receivable_aging: "AR Aging",
  accounts_payable_aging: "AP Aging",
  equipment_quote: "Equipment Quote",
  equipment_invoice: "Equipment Invoice",
  personal_net_worth: "Personal Net Worth",
  purchase_order: "Purchase Order",
  lease_agreement: "Lease Agreement",
};

export function documentTypeTitle(category: string | null, detectedType?: string | null): string {
  if (detectedType && KEY_LABELS[detectedType]) return KEY_LABELS[detectedType];
  const raw = String(category ?? "").toLowerCase();
  if (/balance.?sheet/.test(raw)) return "Balance Sheet";
  if (/p&l|\bpnl\b|profit|income statement/.test(raw)) return "Profit and Loss";
  const key = resolveExpectedDocumentKey(category);
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const text = String(category ?? "").trim();
  return text ? text.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()) : "Document";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A period read from the uploaded filename; null when there is nothing reliable. */
export function periodFromFilename(filename: string | null, monthOnly: boolean): string | null {
  const name = String(filename ?? "");
  const compact = name.match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?!\d)/);
  if (compact) return monthOnly ? `${compact[1]}-${compact[2]}` : `${compact[1]}-${compact[2]}-${compact[3]}`;
  const mdy = name.match(/(?<!\d)(1[0-2]|0?[1-9])[./-](3[01]|[12]\d|0?[1-9])[./-](\d{4}|\d{2})(?!\d)/);
  if (mdy) {
    const year = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return monthOnly ? `${year}-${pad(Number(mdy[1]))}` : `${year}-${pad(Number(mdy[1]))}-${pad(Number(mdy[2]))}`;
  }
  const year = name.match(/(?<!\d)(20\d{2})(?!\d)/);
  return year ? year[1] : null;
}

function extensionOf(filename: string | null): string {
  const m = String(filename ?? "").match(/\.([a-z0-9]{2,5})$/i);
  return m ? `.${m[1].toLowerCase()}` : ".pdf";
}

export function sanitizeDisplayName(name: string, originalFilename: string | null): string | null {
  const cleaned = String(name ?? "")
    .replace(/[\u0000-\u001f\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150)
    .trim();
  if (!cleaned) return null;
  return /\.[a-z0-9]{2,5}$/i.test(cleaned) ? cleaned : `${cleaned}${extensionOf(originalFilename)}`;
}

export function uniqueDisplayName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 100; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

export function suggestDocumentName(input: {
  businessName: string | null;
  category: string | null;
  detectedType?: string | null;
  filename: string | null;
}): string {
  const type = documentTypeTitle(input.category, input.detectedType);
  const period = periodFromFilename(input.filename, type === "Bank Statement");
  const parts = [input.businessName?.trim() || null, type, period].filter(Boolean) as string[];
  return sanitizeDisplayName(parts.join(" - "), input.filename) ?? `Document${extensionOf(input.filename)}`;
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
const defaultQuery: Query = (sql, params) => pool.query(sql, params as any[]);

export async function loadNamingContext(documentId: string, query: Query = defaultQuery) {
  const { rows } = await query(
    `SELECT d.id::text AS id, d.application_id::text AS application_id, d.filename, d.display_name,
            COALESCE(d.document_type, d.category) AS category, d.detected_type, d.detected_confidence,
            COALESCE(NULLIF(NULLIF(NULLIF(a.name, ''), 'Draft application'), 'Untitled Application'), c.name) AS business_name
       FROM documents d
       LEFT JOIN applications a ON a.id = d.application_id
       LEFT JOIN companies c ON c.id = a.company_id
      WHERE d.id::text = ($1)::text
      LIMIT 1`,
    [documentId],
  );
  const doc = rows[0];
  if (!doc) return null;
  const others = await query(
    `SELECT COALESCE(display_name, filename) AS name FROM documents
      WHERE application_id::text = ($1)::text AND id::text <> ($2)::text`,
    [doc.application_id, documentId],
  );
  const confident = doc.detected_confidence !== null && Number(doc.detected_confidence) >= 0.6;
  return {
    filename: doc.filename as string | null,
    displayName: doc.display_name as string | null,
    suggestedName: suggestDocumentName({
      businessName: doc.business_name ?? null,
      category: doc.category ?? null,
      detectedType: confident ? doc.detected_type : null,
      filename: doc.filename ?? null,
    }),
    existingNames: (others.rows ?? []).map((r) => String(r.name ?? "")).filter(Boolean),
  };
}
