// BF_SERVER_DOC_SHARING_v635
// Before a client is asked for a document, look for it on their other applications:
//   personal documents (ID, personal tax) - any of that client's applications;
//   business documents - only applications for the same business (same legal name).
// A match is copied onto this application as an ordinary document (same stored file),
// so it counts as uploaded, shows in the portal and goes into the lender package. The
// copy is recorded in document_shares so staff can see where it came from.
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import { businessKey, canonicalDocKey, isPersonalDoc } from "./documentKinds.js";

type Needed = { document_type: string };
type SourceDoc = { id: string; application_id: string; app_name: string | null; category: string | null; document_type: string | null };

/** Pure: pick the newest usable document on another application for each needed kind. */
export function planShares(
  needed: Needed[],
  thisBusiness: string,
  candidates: SourceDoc[],
): Array<{ neededType: string; kind: string; source: SourceDoc }> {
  const out: Array<{ neededType: string; kind: string; source: SourceDoc }> = [];
  const seen = new Set<string>();
  for (const n of needed) {
    const kind = canonicalDocKey(n.document_type);
    if (!kind || seen.has(kind)) continue;
    const personal = isPersonalDoc(n.document_type);
    const match = candidates.find((c) =>
      canonicalDocKey(c.category ?? c.document_type) === kind
      && (personal || (thisBusiness !== "" && businessKey(c.app_name) === thisBusiness)));
    if (match) { out.push({ neededType: n.document_type, kind, source: match }); seen.add(kind); }
  }
  return out;
}

export async function shareFromOtherApplications(applicationId: string, needed: Needed[]): Promise<number> {
  if (!needed.length) return 0;
  const me = await pool.query<{ name: string | null; contact_id: string | null; phone10: string | null; root_id: string }>(
    `SELECT a.name, a.contact_id::text AS contact_id,
            NULLIF(right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10), '') AS phone10,
            COALESCE(a.parent_application_id, a.id)::text AS root_id
       FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const app = me.rows[0];
  if (!app || (!app.contact_id && !app.phone10)) return 0;

  // The client's other applications (by contact, or by the contact's phone), outside this
  // application's own family (a closing-costs companion already shares with its parent).
  const docs = await pool.query<SourceDoc>(
    `SELECT d.id, d.application_id, a.name AS app_name, d.category, d.document_type
       FROM documents d
       JOIN applications a ON a.id::text = d.application_id::text
       LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE COALESCE(a.parent_application_id, a.id)::text <> ($1)::text
        AND (($2::text IS NOT NULL AND a.contact_id::text = $2::text)
          OR ($3::text IS NOT NULL AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $3::text))
        AND COALESCE(d.status, '') <> 'rejected'
        AND COALESCE(d.category, d.document_type, '') <> ''
      ORDER BY d.created_at DESC
      LIMIT 500`,
    [app.root_id, app.contact_id, app.phone10],
  );
  const plan = planShares(needed, businessKey(app.name), docs.rows);
  let copied = 0;
  for (const p of plan) {
    try {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO documents (id, application_id, owner_user_id, title, created_at, document_type, version, status,
                                filename, storage_key, uploaded_by, borrower_id, file_url, object_key, uploaded_at,
                                signed_category, ocr_status, blob_name, blob_url, hash, category, storage_path,
                                size_bytes, detected_type, detected_confidence, detected_at, display_name)
         SELECT gen_random_uuid()::text, ($2)::text, owner_user_id, title, now(), document_type, 1, status,
                filename, storage_key, uploaded_by, borrower_id, file_url, object_key, uploaded_at,
                signed_category, ocr_status, blob_name, blob_url, hash, ($3)::text, storage_path,
                size_bytes, detected_type, detected_confidence, detected_at, display_name
           FROM documents WHERE id = ($1)::text
         RETURNING id`,
        [p.source.id, applicationId, p.neededType],
      );
      const newId = ins.rows[0]?.id;
      if (!newId) continue;
      await pool.query(
        `INSERT INTO document_shares (target_document_id, target_application_id, source_document_id, source_application_id, document_kind)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (target_application_id, document_kind) DO NOTHING`,
        [newId, applicationId, p.source.id, String(p.source.application_id), p.kind],
      );
      copied += 1;
    } catch (err: any) {
      logError("document_share_failed", { applicationId, sourceDocumentId: p.source.id, message: err?.message });
    }
  }
  return copied;
}

/** For staff: which of this application's documents were shared, and from which application. */
export async function sharedDocumentsFor(applicationId: string): Promise<Array<{ document_type: string; from_application_id: string; from_name: string | null }>> {
  const r = await pool.query<{ document_type: string; from_application_id: string; from_name: string | null }>(
    `SELECT d.category AS document_type, s.source_application_id AS from_application_id, a.name AS from_name
       FROM document_shares s
       JOIN documents d ON d.id = s.target_document_id
       LEFT JOIN applications a ON a.id::text = s.source_application_id
      WHERE s.target_application_id = ($1)::text`,
    [applicationId],
  ).catch((err: any) => { logError("document_shares_read_failed", { applicationId, message: err?.message }); return { rows: [] as Array<{ document_type: string; from_application_id: string; from_name: string | null }> }; });
  return r.rows;
}
