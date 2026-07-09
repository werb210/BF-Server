// BF_SERVER_OFFER_TERMSHEET_SIGNING_v1 - fills the module the offer
// confirm-acceptance handler already tries to import. Takes the LENDER's
// uploaded term sheet, stamps a single client signature field on the last page
// (proven SignNow fieldextract text-tag, drawn white so it is invisible),
// creates a one-doc / one-signer embedded SignNow envelope, and stores the
// group/doc ids + signing URL on the application metadata. Mirrors
// src/signnow/pnwSigning.ts (proven in production).
//
// SLICE 1: one signature field at a safe default spot (lower-right of the last
// page). Auto-detection + staff field editor are later slices. The pdf-lib
// stamping is verifiable locally; the SignNow upload/invite calls reuse the
// exact proven PNW path but MUST be smoke-tested against the live SignNow
// account before relying on them.
import { randomUUID, createHash } from "node:crypto";
import type { Pool } from "pg";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  isApiKeyConfigured,
  uploadDocumentWithFieldExtract,
  createDocumentGroup,
  createEmbeddedGroupInvite,
  createEmbeddedGroupLink,
  getDocumentGroupStatus,
  downloadDocument,
} from "../../signnow/signnowClient.js";
import { getStorage } from "../../lib/storage/index.js";

export const SIGNED_TERM_SHEET_CATEGORY = "Signed Term Sheet";
const SIGNER_ROLE = "Client";

type OfferRow = {
  id: string;
  application_id: string | null;
  term_sheet_blob_name: string | null;
  document_url: string | null;
  lender_name: string | null;
};

async function resolveOffer(pool: Pool, offerId: string): Promise<OfferRow | null> {
  const r = await pool.query<OfferRow>(
    `SELECT id::text AS id, application_id::text AS application_id,
            term_sheet_blob_name, document_url, lender_name
       FROM offers WHERE id::text = $1 LIMIT 1`,
    [offerId],
  );
  return r.rows[0] ?? null;
}

async function resolveSigner(pool: Pool, applicationId: string): Promise<{ email: string; name: string } | null> {
  const c = await pool
    .query<{ email: string | null; first_name: string | null; last_name: string | null; name: string | null }>(
      `SELECT c.email, c.first_name, c.last_name, c.name
         FROM applications a JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = $1 LIMIT 1`,
      [applicationId],
    )
    .catch(() => ({ rows: [] as any[] }));
  const row = c.rows[0];
  if (!row) return null;
  const email = String(row.email ?? "").trim();
  const name = String(row.name ?? [row.first_name, row.last_name].filter(Boolean).join(" ")).trim();
  if (!email) return null;
  return { email, name };
}

// Stamp an invisible SignNow signature text-tag on the last page. Tag syntax is
// copied verbatim from the proven PNW/Accord builders ({{t:s;r:y;o:"<role>"}}
// drawn white). Date uses t:t (t:d breaks fieldextract 65656 on this account).
async function stampSignatureField(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const page = pages[pages.length - 1];
  const { height } = page.getSize();
  const white = rgb(1, 1, 1);
  const sigTag = `{{t:s;r:y;o:"${SIGNER_ROLE}";w:200;h:20;}}`;
  const dateTag = `{{t:t;r:y;o:"${SIGNER_ROLE}";w:110;h:16;}}`;
  page.drawText(sigTag, { x: 342, y: height - 372, size: 6, font, color: white });
  page.drawText(dateTag, { x: 342, y: height - 402, size: 6, font, color: white });
  return doc.save();
}

export async function sendOfferTermSheet(params: { pool: Pool; offerId: string }): Promise<{ url: string | null; reason?: string }> {
  const { pool, offerId } = params;
  if (!isApiKeyConfigured()) return { url: null, reason: "signnow_not_configured" };

  const offer = await resolveOffer(pool, offerId);
  if (!offer) return { url: null, reason: "offer_not_found" };
  if (!offer.application_id) return { url: null, reason: "no_application" };
  if (!offer.term_sheet_blob_name) return { url: null, reason: "no_term_sheet" };

  const signer = await resolveSigner(pool, offer.application_id);
  if (!signer) return { url: null, reason: "no_signer" };

  const blob = await getStorage().get(offer.term_sheet_blob_name);
  if (!blob || !blob.buffer || blob.buffer.length === 0) return { url: null, reason: "term_sheet_download_failed" };

  const stamped = await stampSignatureField(blob.buffer);
  const lender = (offer.lender_name || "Lender").replace(/[^\w .-]/g, "").slice(0, 40);
  const { documentId } = await uploadDocumentWithFieldExtract(stamped, `term-sheet-${lender}-${offer.id}.pdf`);
  const { groupId } = await createDocumentGroup([documentId], `Term Sheet ${lender} ${offer.id}`);
  const { inviteId } = await createEmbeddedGroupInvite(groupId, [documentId], [{ email: signer.email, name: signer.name || undefined, roleName: SIGNER_ROLE }]);
  const { url } = await createEmbeddedGroupLink(groupId, inviteId, signer.email);

  await pool.query(
    `UPDATE applications
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'offer_signnow', jsonb_build_object(
                'offer_id', $2::text, 'group_id', $3::text, 'invite_id', $4::text,
                'doc_id', $5::text, 'signer_email', $6::text, 'signing_url', $7::text,
                'created_at', now()::text)),
            updated_at = now()
      WHERE id::text = $1`,
    [offer.application_id, offer.id, groupId, inviteId, documentId, signer.email, url ?? null],
  );

  return { url };
}

// Attach the SIGNED term sheet to the application Documents list. Mirrors
// attachSignedPnwDocument: idempotent by content hash, best-effort, never throws.
export async function attachSignedTermSheet(pool: Pool, applicationId: string): Promise<{ attached: boolean; reason?: string }> {
  if (!applicationId) return { attached: false, reason: "missing_application_id" };
  if (!isApiKeyConfigured()) return { attached: false, reason: "signnow_not_configured" };
  try {
    const r = await pool.query<{ group_id: string | null; doc_id: string | null }>(
      `SELECT metadata->'offer_signnow'->>'group_id' AS group_id,
              metadata->'offer_signnow'->>'doc_id'   AS doc_id
         FROM applications WHERE id::text = $1 LIMIT 1`,
      [applicationId],
    );
    const groupId = r.rows[0]?.group_id;
    const docId = r.rows[0]?.doc_id;
    if (!groupId || !docId) return { attached: false, reason: "no_offer_session" };

    const status = await getDocumentGroupStatus(groupId);
    if (!status.signed) return { attached: false, reason: "not_signed" };

    const pdf = await downloadDocument(docId);
    if (!pdf || pdf.length === 0) return { attached: false, reason: "download_failed" };

    const hash = createHash("sha256").update(pdf).digest("hex");
    const dup = await pool
      .query<{ id: string }>(`SELECT id::text AS id FROM documents WHERE application_id::text = $1 AND hash = $2 LIMIT 1`, [applicationId, hash])
      .catch(() => ({ rows: [] as { id: string }[] }));
    if (dup.rows.length > 0) return { attached: true, reason: "already_attached" };

    const filename = `Signed-Term-Sheet-${applicationId}.pdf`;
    const put = await getStorage().put({ buffer: pdf, filename, contentType: "application/pdf", pathPrefix: `applications/${applicationId}` });

    const documentId = randomUUID();
    const versionId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO documents
           (id, application_id, filename, hash, category, storage_path, blob_name, blob_url, size_bytes,
            status, ocr_status, uploaded_by, document_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted','skipped','system','signed_term_sheet',now(),now())`,
        [documentId, applicationId, filename, hash, SIGNED_TERM_SHEET_CATEGORY, put.blobName, put.blobName, put.url, put.sizeBytes],
      );
      await client.query(
        `INSERT INTO document_versions (id, document_id, version, blob_name, hash, metadata, content, created_at)
         VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,now())`,
        [versionId, documentId, put.blobName, hash, JSON.stringify({ source: "signnow_term_sheet", groupId, docId, signedAt: new Date().toISOString() }), put.url],
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
