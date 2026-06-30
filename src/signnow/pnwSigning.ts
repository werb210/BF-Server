// BF_SERVER_BLOCK_v_PNW_SIGNING_v1 — standalone signing for the Personal Net
// Worth statement. The PNW is signed INDIVIDUALLY the moment the applicant
// submits it (a one-document, one-signer SignNow envelope), separate from the
// application signing group. The signed copy is then preferred in the lender
// package over the freshly-rendered fill.
import { dbQuery } from "../db.js";
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


// BF_SERVER_BLOCK_PNW_ORDER_GATE_v1 — ordering helpers. The Personal Net Worth
// statement must be SIGNED before the application signing session may open, and
// before the lender package may ship. Requiredness is read from
// application_required_documents (the same source the CMP uses); signed-ness is
// the live SignNow group status. Both never throw.
export async function isPnwRequired(applicationId: string): Promise<boolean> {
  try {
    const r = await dbQuery<{ one: number }>(
      `SELECT 1 AS one
         FROM application_required_documents
        WHERE application_id::text = ($1)::text
          AND document_category IN ('personal_net_worth','net_worth_statement')
          AND is_required = true
        LIMIT 1`, [applicationId]);
    return (r.rows.length ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function isPnwSigned(applicationId: string): Promise<boolean> {
  if (!isApiKeyConfigured()) return false;
  try {
    const r = await dbQuery<{ group_id: string | null }>(
      `SELECT metadata->'pnw_signnow'->>'group_id' AS group_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
    const groupId = r.rows[0]?.group_id;
    if (!groupId) return false;
    const status = await getDocumentGroupStatus(groupId);
    return status.signed === true;
  } catch {
    return false;
  }
}

// Gate predicate: true => OK to proceed (PNW not required, or required and signed).
// false => a required PNW is not yet signed; callers must block / requeue.
export async function pnwSigningSatisfied(applicationId: string): Promise<boolean> {
  if (!(await isPnwRequired(applicationId))) return true;
  return await isPnwSigned(applicationId);
}
