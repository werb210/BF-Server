// BF_SERVER_CREDIT_DOC_KINDS_v783 - documents are filed under the requirement label staff and applicants see
// ("3 years accountant prepared financials", "A/R", "6 months business banking statements"), not only canonical keys.
// The credit summary readers matched canonical keys exactly, so "Read financials" found 0 of 7 statements, A/R aging
// was never read, and the draft said "No bank statements" with 7 on file. Resolve every label the same way the
// document checks do (resolveExpectedDocumentKey), and never read rejected documents.
import { pool } from "../../db.js";
import { resolveExpectedDocumentKey } from "../documents/classifyDocument.js";

export type CreditDoc = { id: string; name: string | null; category: string; kind: string; ocr_text: string | null; status?: string | null; ocr_status?: string | null; detected_type?: string | null };

// BF_SERVER_v906_CREDIT_STEPS - accountant-prepared statements are filed under many names ("Compilation engagement
// report", "Notice to reader", "Review engagement", "Audited statements", "Year end statements"). They are financial
// statements; resolveExpectedDocumentKey only knew the requirement labels, so "Read financials" found none of them.
const STATEMENT_WORDS = /(compilation|notice to reader|\bntr\b|review engagement|audited|year[\s-]*end|interim|financial|balance sheet|income statement|profit|\bp\s*&\s*l\b|\bpnl\b|statement of operations|retained earnings)/i;
export const kindOf = (category: string | null | undefined): string => {
  const resolved = resolveExpectedDocumentKey(category) || String(category ?? "");
  const raw = String(category ?? "");
  if (resolved !== "financial_statements" && !/bank|tax|a\/[rp]|receivable|payable/i.test(raw) && STATEMENT_WORDS.test(raw)) return "financial_statements";
  return resolved;
};

export async function documentsOfKinds(applicationId: string, kinds: readonly string[]): Promise<CreditDoc[]> {
  const want = new Set(kinds);
  const { rows } = await pool.query<{ id: string; name: string | null; category: string | null; ocr_text: string | null; status?: string | null; ocr_status?: string | null; detected_type?: string | null }>(
    `SELECT d.id::text AS id, COALESCE(d.filename, d.category) AS name, COALESCE(d.category, d.document_type) AS category, o.extracted_text AS ocr_text,
            d.status, d.ocr_status, d.detected_type
       FROM documents d
       LEFT JOIN LATERAL (SELECT extracted_text FROM ocr_document_results r WHERE r.document_id = d.id ORDER BY r.created_at DESC LIMIT 1) o ON true
      WHERE d.application_id::text = $1 AND COALESCE(d.status, '') <> 'rejected'
      ORDER BY d.created_at ASC`,
    [applicationId],
  );
  return rows
    .map((r) => ({ ...r, category: String(r.category ?? ""), kind: kindOf(r.category) }))
    .map((r) => {
      // BF_SERVER_v906_CREDIT_STEPS - a statement filed under "Other" that OCR recognised as financial statements counts too.
      if (!want.has(r.kind) && /financial|balance|income|profit/i.test(String(r.detected_type ?? ""))) return { ...r, kind: kindOf(String(r.detected_type)) };
      return r;
    })
    .filter((r) => want.has(r.kind) || want.has(r.category));
}

// BF_SERVER_v906_CREDIT_STEPS - a statement whose OCR has not finished (or failed) was skipped with "no readable text
// yet", so "Read financials" said "No financials read yet" with the statements accepted on the file. Read the text
// straight from the file instead (text PDFs need no OCR; scans go through Document Intelligence), and queue its OCR so
// the next run has it.
export async function readableTextFor(documentId: string): Promise<string | null> {
  const v = await pool.query<{ content: string | null; metadata: any; filename: string | null }>(
    `SELECT dv.content, dv.metadata, d.filename
       FROM document_versions dv JOIN documents d ON d.id = dv.document_id
      WHERE dv.document_id = $1 ORDER BY dv.version DESC LIMIT 1`,
    [documentId],
  );
  const row = v.rows[0];
  if (!row?.content) return null;
  const { createOcrStorage } = await import("../../modules/ocr/ocr.storage.js");
  const { resolveMimeType } = await import("../../modules/ocr/mimeType.js");
  const buffer = await createOcrStorage().fetchBuffer({ content: row.content });
  const mime = resolveMimeType({ stored: row.metadata?.mimeType, fileNames: [row.metadata?.fileName, row.filename], buffer }).mimeType;
  if (!mime) return null;
  const { documentText } = await import("../brokerImport/extract.js");
  const text = String((await documentText(buffer, mime)) ?? "");
  return text.replace(/\s/g, "").length >= 200 ? text : null;
}

export async function queueOcr(documentId: string): Promise<void> {
  try {
    const { enqueueOcrForDocument } = await import("../../modules/ocr/ocr.service.js");
    await enqueueOcrForDocument(documentId);
  } catch (err) {
    console.warn("[credit-docs] ocr_queue_failed", { documentId, message: (err as Error)?.message });
  }
}
