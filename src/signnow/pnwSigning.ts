// BF_SERVER_BLOCK_v_PNW_SIGNING_v1 — standalone signing for the Personal Net
// Worth statement. The PNW is signed INDIVIDUALLY the moment the applicant
// submits it (a one-document, one-signer SignNow envelope), separate from the
// application signing group. The signed copy is then preferred in the lender
// package over the freshly-rendered fill.
import { randomUUID, createHash } from "node:crypto";
import { dbQuery, pool } from "../db.js";
import {
  isApiKeyConfigured,
  uploadDocumentWithFieldExtract,
  createDocumentGroup,
  createEmbeddedGroupInvite,
  createEmbeddedGroupLink,
  getDocumentGroupStatus,
  downloadDocument,
} from "./signnowClient.js";
import { buildPnwPdf } from "./pnwPdfBuilder.js";
import { getStorage } from "../lib/storage/index.js";

// Category shown in the staff Documents list for the signed PNW.
export const PNW_DOCUMENT_CATEGORY = "Personal Net Worth";

export const PNW_DOC_TYPES = ["net_worth_statement", "personal_net_worth"];
export function isPnwDocType(docType: string): boolean { return PNW_DOC_TYPES.includes(docType); }

async function resolveSigner(applicationId: string): Promise<{ email: string; name: string } | null> {
  const fr = await dbQuery<{ data: any }>(
    `SELECT data FROM application_form_responses
      WHERE application_id::text = ($1)::text AND doc_type IN ('net_worth_statement','personal_net_worth')
      ORDER BY submitted_at DESC NULLS LAST LIMIT 1`, [applicationId]).catch(() => ({ rows: [] as { data: any }[] }));
  const f = (fr.rows[0]?.data?.fields ?? {}) as Record<string, unknown>;
  let email = String(f.primary_email ?? "").trim();
  let name = String(f.primary_name ?? "").trim();
  if (!email || !name) {
    const c = await dbQuery<{ email: string | null; first_name: string | null; last_name: string | null }>(
      `SELECT c.email, c.first_name, c.last_name
         FROM applications a JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = ($1)::text LIMIT 1`, [applicationId]).catch(() => ({ rows: [] as any[] }));
    email = email || String(c.rows[0]?.email ?? "").trim();
    name = name || [c.rows[0]?.first_name, c.rows[0]?.last_name].filter(Boolean).join(" ").trim();
  }
  if (!email) return null;
  return { email, name };
}

// Create a fresh single-doc / single-signer envelope for the latest PNW and
// return an embedded signing link. Stores the group/doc ids on the application
// metadata so the signed copy can be pulled into the package later. Always
// creates a fresh group so the signer sees the latest submitted data.
export async function createPnwSigningSession(applicationId: string): Promise<{ url: string | null }> {
  if (!isApiKeyConfigured()) return { url: null };
  const signer = await resolveSigner(applicationId);
  if (!signer) return { url: null };
  const pdf = await buildPnwPdf(applicationId);
  const { documentId } = await uploadDocumentWithFieldExtract(pdf, `personal-net-worth-${applicationId}.pdf`);
  const { groupId } = await createDocumentGroup([documentId], `Personal Net Worth ${applicationId}`);
  const { inviteId } = await createEmbeddedGroupInvite(groupId, [documentId], [{ email: signer.email, name: signer.name || undefined, roleName: "Owner 1" }]);
  const { url } = await createEmbeddedGroupLink(groupId, inviteId, signer.email);
  await dbQuery(
    `UPDATE applications
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'pnw_signnow', jsonb_build_object(
                'group_id', $2::text, 'invite_id', $3::text, 'doc_id', $4::text,
                'signer_email', $5::text, 'created_at', now()::text)),
            updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId, groupId, inviteId, documentId, signer.email]);
  return { url };
}

// If the PNW has been signed, return the signed PDF; otherwise null (caller
// falls back to the rendered fill). Never throws.
export async function getSignedPnwPdf(applicationId: string): Promise<Buffer | null> {
  if (!isApiKeyConfigured()) return null;
  try {
    const r = await dbQuery<{ group_id: string | null; doc_id: string | null }>(
      `SELECT metadata->'pnw_signnow'->>'group_id' AS group_id,
              metadata->'pnw_signnow'->>'doc_id'   AS doc_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
    const groupId = r.rows[0]?.group_id, docId = r.rows[0]?.doc_id;
    if (!groupId || !docId) return null;
    const status = await getDocumentGroupStatus(groupId);
    if (!status.signed) return null;
    return await downloadDocument(docId);
  } catch {
    return null;
  }
}

// BF_SERVER_PNW_ATTACH_v1 — attach the SIGNED Personal Net Worth PDF to the
// application's Documents list. The PNW is signed in its own SignNow envelope
// and was previously only fetched for the lender package, so no `documents`
// row existed for staff to view. Best-effort and idempotent by content hash:
// repeated webhook delivery or backfill calls no-op and never throw.
export async function attachSignedPnwDocument(applicationId: string): Promise<{ attached: boolean; reason?: string }> {
  if (!applicationId) return { attached: false, reason: "missing_application_id" };
  if (!isApiKeyConfigured()) return { attached: false, reason: "signnow_not_configured" };

  try {
    const r = await dbQuery<{ group_id: string | null; doc_id: string | null }>(
      `SELECT metadata->'pnw_signnow'->>'group_id' AS group_id,
              metadata->'pnw_signnow'->>'doc_id'   AS doc_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId],
    );
    const groupId = r.rows[0]?.group_id;
    const docId = r.rows[0]?.doc_id;
    if (!groupId || !docId) return { attached: false, reason: "no_pnw_session" };

    const status = await getDocumentGroupStatus(groupId);
    if (!status.signed) return { attached: false, reason: "not_signed" };

    const pdf = await downloadDocument(docId);
    if (!pdf || pdf.length === 0) return { attached: false, reason: "download_failed" };

    const hash = createHash("sha256").update(pdf).digest("hex");
    const dup = await dbQuery<{ id: string }>(
      `SELECT id::text AS id FROM documents
        WHERE application_id::text = ($1)::text AND hash = $2
        LIMIT 1`,
      [applicationId, hash],
    ).catch(() => ({ rows: [] as { id: string }[] }));
    if (dup.rows.length > 0) return { attached: true, reason: "already_attached" };

    const filename = `Personal-Net-Worth-Signed-${applicationId}.pdf`;
    const put = await getStorage().put({
      buffer: pdf,
      filename,
      contentType: "application/pdf",
      pathPrefix: `applications/${applicationId}`,
    });

    const documentId = randomUUID();
    const versionId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO documents
           (id, application_id, filename, hash, category,
            storage_path, blob_name, blob_url, size_bytes,
            status, ocr_status, uploaded_by, document_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted','skipped','system',$10,now(),now())`,
        [
          documentId,
          applicationId,
          filename,
          hash,
          PNW_DOCUMENT_CATEGORY,
          put.blobName,
          put.blobName,
          put.url,
          put.sizeBytes,
          "personal_net_worth",
        ],
      );
      await client.query(
        `INSERT INTO document_versions
           (id, document_id, version, blob_name, hash, metadata, content, created_at)
         VALUES ($1, $2, 1, $3, $4, $5::jsonb, $6, now())`,
        [
          versionId,
          documentId,
          put.blobName,
          hash,
          JSON.stringify({
            source: "signnow_pnw",
            groupId,
            docId,
            signedAt: new Date().toISOString(),
          }),
          put.url,
        ],
      );
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return { attached: false, reason: "insert_failed" };
    } finally {
      client.release();
    }

    return { attached: true };
  } catch {
    return { attached: false, reason: "error" };
  }
}


// BF_SERVER_BLOCK_PNW_GATE_v1 — gate helper for the lender package worker.
// Returns true when no PNW signing group exists for the app (PNW not in play)
// OR the existing PNW group is fully signed. Returns false when a PNW group
// exists but is not yet signed (or its status cannot be confirmed) — so the
// dispatch worker requeues instead of shipping an unsigned PNW. Never throws.
export async function isPnwSignedOrAbsent(applicationId: string): Promise<boolean> {
  if (!isApiKeyConfigured()) return true;
  try {
    const r = await dbQuery<{ group_id: string | null }>(
      `SELECT metadata->'pnw_signnow'->>'group_id' AS group_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
    const groupId = r.rows[0]?.group_id;
    if (!groupId) return true; // no PNW signing session => nothing to gate on
    const status = await getDocumentGroupStatus(groupId);
    return status.signed === true;
  } catch {
    return false; // never ship unsigned on an unconfirmed status; requeue instead
  }
}

// BF_SERVER_BLOCK_PNW_ORDER_GATE_v2 — ordering helpers anchored on the PNW
// signing GROUP (which exists exactly when a PNW is in play; the
// application_required_documents table is NOT reliably populated for PNW).
async function pnwGroupId(applicationId: string): Promise<string | null> {
  try {
    const r = await dbQuery<{ group_id: string | null }>(
      `SELECT metadata->'pnw_signnow'->>'group_id' AS group_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
    return r.rows[0]?.group_id ?? null;
  } catch {
    return null;
  }
}

// App-signing gate: block ONLY on a confirmed-unsigned PNW. No group => no PNW
// in play => allow. Group present but SignNow status cannot be confirmed (outage)
// => allow: nothing can be signed during an outage anyway.
export async function pnwSigningSatisfiedForAppSigning(applicationId: string): Promise<boolean> {
  if (!isApiKeyConfigured()) return true;
  const groupId = await pnwGroupId(applicationId);
  if (!groupId) return true;
  try {
    const status = await getDocumentGroupStatus(groupId);
    return status.signed === true ? true : false;
  } catch {
    return true;
  }
}

// Dispatch gate (stricter): never ship a package while a PNW group exists and is
// not confirmed-signed. On a status error this returns false so the worker
// REQUEUES (waits) rather than shipping an unsigned PNW.
export async function pnwSigningSatisfiedForDispatch(applicationId: string): Promise<boolean> {
  if (!isApiKeyConfigured()) return true;
  const groupId = await pnwGroupId(applicationId);
  if (!groupId) return true;
  try {
    const status = await getDocumentGroupStatus(groupId);
    return status.signed === true;
  } catch {
    return false;
  }
}
