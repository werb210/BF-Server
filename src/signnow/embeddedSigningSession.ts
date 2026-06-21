// BF_SERVER_BLOCK_v712_EMBEDDED_GROUP_SIGNING_v1
// BF_SERVER_BLOCK_v203_SIGNNOW_ACCORD_GROUP_v1
import { dbQuery } from "../db.js";
import { loadApplicationForPdf } from "./sendApplicationForSignature.js";
import { buildApplicationPdf } from "./pdfBuilder.js";
import { buildAccordPdf } from "./accordPdfBuilder.js";
import { uploadSignedApplicationPdf } from "./blobStorage.js";
import * as signnow from "./signnowClient.js";

const ROLE_OWNER1 = "Owner 1";
const ROLE_OWNER2 = "Owner 2";
function fromEmail(): string { return process.env.SIGNNOW_FROM_EMAIL || "no-reply@boreal.financial"; }
function isStubMode(): boolean { const v = (process.env.SIGNNOW_STUB_MODE ?? "").trim().toLowerCase(); return ["1", "true", "yes", "on"].includes(v); }

export type SigningSessionResult =
  | { status: "signed" }
  | { status: "not_ready"; reason: string }
  | { status: "stub"; reason?: string }
  | { status: "ready"; url: string; expiresAt: string | null }
  | { status: "error"; reason: string };

async function isAccordFinalized(applicationId: string): Promise<boolean> {
  const res = await dbQuery<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM application_lender_selections s
       JOIN lenders l ON l.id::text = s.lender_id::text
       JOIN applications a ON a.id::text = s.application_id::text
      WHERE s.application_id::text = ($1)::text
        AND s.finalized_at IS NOT NULL
        AND l.name ILIKE 'accord%'
        AND upper(coalesce(a.product_category, '')) = 'LOC'`, [applicationId]).catch(() => ({ rows: [{ n: "0" }] }));
  return Number(res.rows[0]?.n ?? 0) > 0;
}

export async function getOrCreateEmbeddedSigningSession(applicationId: string): Promise<SigningSessionResult> {
  if (!applicationId) return { status: "not_ready", reason: "missing_application_id" };
  const appRes = await dbQuery<{ signnow_app_signed_at: string | null; metadata: any; finalized_count: string }>(
    `SELECT a.signnow_app_signed_at, a.metadata,
            (SELECT COUNT(*) FROM application_lender_selections s
              WHERE s.application_id::text = a.id::text AND s.finalized_at IS NOT NULL) AS finalized_count
       FROM applications a WHERE a.id::text = ($1)::text LIMIT 1`, [applicationId]);
  const row = appRes.rows[0];
  if (!row) return { status: "not_ready", reason: "application_not_found" };
  if (row.signnow_app_signed_at) return { status: "signed" };
  if (Number(row.finalized_count ?? 0) <= 0) return { status: "not_ready", reason: "lender_not_finalized" };
  if (isStubMode()) return { status: "stub", reason: "SIGNNOW_STUB_MODE is enabled on this server" };
  if (!signnow.isApiKeyConfigured()) return { status: "stub", reason: "SIGNNOW_API_KEY is empty on this server" };

  try {
    const md = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, any>) : {};
    const inputs = await loadApplicationForPdf(applicationId);
    const email = inputs.applicantEmail;
    if (!email) return { status: "not_ready", reason: "no_applicant_email" };

    const sess = md.signnow_embedded && typeof md.signnow_embedded === "object" ? md.signnow_embedded : null;
    if (sess?.group_id && sess?.invite_id) {
      const link = await signnow.createEmbeddedGroupLink(String(sess.group_id), String(sess.invite_id), email);
      return { status: "ready", url: link.url, expiresAt: link.expiresAt };
    }

    const docIds: string[] = [];
    const borealPdf = await buildApplicationPdf(inputs);
    // BF_SERVER_SIGNNOW_GROUP_BLOB_v1 — persist the formatted application PDF to blob so the
    // lender package keeps the real PDF (loadSignedApplicationPdf reads signed_application_blob_name;
    // without this it falls back to a plain-text field dump).
    let blobName: string | null = null;
    let blobUrl: string | null = null;
    try { const up = await uploadSignedApplicationPdf(applicationId, Buffer.from(borealPdf)); blobName = up.blobName; blobUrl = up.url; } catch { /* non-fatal: lender package falls back to text render */ }
    const boreal = await signnow.uploadDocumentWithFieldExtract(borealPdf, `app-${applicationId}.pdf`);
    docIds.push(boreal.documentId);

    if (await isAccordFinalized(applicationId)) {
      try {
        const accordPdf = await buildAccordPdf(applicationId);
        const accord = await signnow.uploadDocumentWithFieldExtract(accordPdf, `accord-${applicationId}.pdf`);
        docIds.push(accord.documentId);
      } catch (e) {
        console.warn(`[signnow] Accord form skipped for app=${applicationId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const group = await signnow.createDocumentGroup(docIds, `Boreal application ${applicationId}`);
    const invite = await signnow.createEmbeddedGroupInvite(group.groupId, docIds, { email, name: inputs.applicantName ?? undefined, roleName: ROLE_OWNER1 });
    const link = await signnow.createEmbeddedGroupLink(group.groupId, invite.inviteId, email);

    const o2 = inputs.owners[1];
    if (o2?.email) {
      const o2name = [o2.firstName, o2.lastName].filter(Boolean).join(" ").trim() || undefined;
      await signnow.sendGroupEmailInvite(group.groupId, { email: o2.email, name: o2name, roleName: ROLE_OWNER2, fromEmail: fromEmail(), order: 2 }).catch(() => {});
    }

    await dbQuery(
      `UPDATE applications
          SET signnow_document_id = $2,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'signed_application_blob_name', COALESCE($5::text, metadata->>'signed_application_blob_name'),
                  'signed_application_blob_url',  COALESCE($6::text, metadata->>'signed_application_blob_url'))
                || jsonb_build_object(
                  'signnow_embedded', jsonb_build_object(
                    'group_id', $2::text, 'invite_id', $3::text, 'doc_ids', $4::jsonb,
                    'created_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
              updated_at = now()
        WHERE id::text = ($1)::text`,
      [applicationId, group.groupId, invite.inviteId, JSON.stringify(docIds), blobName, blobUrl]);
    return { status: "ready", url: link.url, expiresAt: link.expiresAt };
  } catch (err) {
    console.error(`[signnow] signing-session error app=${applicationId}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    return { status: "error", reason: err instanceof Error ? err.message : "signnow_error" };
  }
}
