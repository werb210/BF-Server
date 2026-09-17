// BF_SERVER_MOVE_DOCUMENT_v315
// Staff move a document to the right category (a bank statement uploaded under
// A/R, for example). category and document_type move together because the
// required-documents checklist reads document_type. A staff move also clears
// the OCR "auto-moved from" marker, since a person has now decided.
type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;

const OUTSIDE_ROLES = new Set(["client", "lender", "referrer", "accountant"]);

/** Any signed-in staff role; clients, lenders, referrers and accountants cannot. */
export function canMoveDocuments(role: unknown): boolean {
  const r = String(role ?? "").trim().toLowerCase();
  return r.length > 0 && !OUTSIDE_ROLES.has(r);
}

export function cleanCategory(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  return v.length > 0 && v.length <= 120 ? v : null;
}

export async function moveDocument(query: Query, documentId: string, category: string, by: string | null) {
  const before = await query(
    `SELECT id::text AS id, application_id::text AS application_id, category FROM documents WHERE id::text = ($1)::text LIMIT 1`,
    [documentId],
  );
  const row = before.rows[0];
  if (!row) return { ok: false as const, reason: "not_found" as const };
  if (row.category === category) return { ok: true as const, applicationId: row.application_id, from: row.category, to: category, changed: false };
  await query(
    `UPDATE documents
        SET category = $2,
            document_type = $2,
            category_before_retag = NULL,
            updated_at = now()
      WHERE id::text = ($1)::text`,
    [documentId, category],
  );
  console.info(JSON.stringify({ event: "document_moved", documentId, applicationId: row.application_id, from: row.category, to: category, by }));
  return { ok: true as const, applicationId: row.application_id, from: row.category, to: category, changed: true };
}
