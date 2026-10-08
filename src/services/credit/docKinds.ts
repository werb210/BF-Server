// BF_SERVER_CREDIT_DOC_KINDS_v783 - documents are filed under the requirement label staff and applicants see
// ("3 years accountant prepared financials", "A/R", "6 months business banking statements"), not only canonical keys.
// The credit summary readers matched canonical keys exactly, so "Read financials" found 0 of 7 statements, A/R aging
// was never read, and the draft said "No bank statements" with 7 on file. Resolve every label the same way the
// document checks do (resolveExpectedDocumentKey), and never read rejected documents.
import { pool } from "../../db.js";
import { resolveExpectedDocumentKey } from "../documents/classifyDocument.js";

export type CreditDoc = { id: string; name: string | null; category: string; kind: string; ocr_text: string | null };

export const kindOf = (category: string | null | undefined): string => resolveExpectedDocumentKey(category) || String(category ?? "");

export async function documentsOfKinds(applicationId: string, kinds: readonly string[]): Promise<CreditDoc[]> {
  const want = new Set(kinds);
  const { rows } = await pool.query<{ id: string; name: string | null; category: string | null; ocr_text: string | null }>(
    `SELECT d.id::text AS id, COALESCE(d.filename, d.category) AS name, COALESCE(d.category, d.document_type) AS category, o.extracted_text AS ocr_text
       FROM documents d
       LEFT JOIN LATERAL (SELECT extracted_text FROM ocr_document_results r WHERE r.document_id = d.id ORDER BY r.created_at DESC LIMIT 1) o ON true
      WHERE d.application_id::text = $1 AND COALESCE(d.status, '') <> 'rejected'
      ORDER BY d.created_at ASC`,
    [applicationId],
  );
  return rows
    .map((r) => ({ ...r, category: String(r.category ?? ""), kind: kindOf(r.category) }))
    .filter((r) => want.has(r.kind) || want.has(r.category));
}
