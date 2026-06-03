// BF_SERVER_BLOCK_v712_EMBEDDED_GROUP_SIGNING_v1
// Builds ONE embedded SignNow signing session for the borrower: our application
// template + each finalized lender's form template, grouped into a single
// document group, signed in one in-portal iframe. No email is sent.
import { dbQuery } from "../db.js";
import { loadApplicationForPdf } from "./sendApplicationForSignature.js";
import * as signnow from "./signnowClient.js";

const SIGNER_ROLE = process.env.SIGNNOW_SIGNER_ROLE || "Borrower";
function isStubMode(): boolean {
  const v = (process.env.SIGNNOW_STUB_MODE ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(v);
}
export type SigningSessionResult =
  | { status: "signed" }
  | { status: "not_ready"; reason: string }
  | { status: "stub" }
  | { status: "ready"; url: string; expiresAt: string | null }
  | { status: "error"; reason: string };

async function resolveTemplateIds(applicationId: string): Promise<string[]> {
  const ids: string[] = [];
  const appTpl = (process.env.SIGNNOW_APPLICATION_TEMPLATE_ID || "").trim();
  if (appTpl) ids.push(appTpl);
  const res = await dbQuery<{ signnow_template_id: string | null }>(
    `SELECT DISTINCT lp.signnow_template_id
       FROM application_lender_selections s
       JOIN lender_products lp ON lp.lender_id::text = s.lender_id::text
      WHERE s.application_id::text = ($1)::text
        AND s.finalized_at IS NOT NULL
        AND lp.signnow_template_id IS NOT NULL
        AND length(trim(lp.signnow_template_id)) > 0`,
    [applicationId],
  );
  for (const r of res.rows) {
    const t = (r.signnow_template_id ?? "").trim();
    if (t && !ids.includes(t)) ids.push(t);
  }
  return ids;
}

export async function getOrCreateEmbeddedSigningSession(applicationId: string): Promise<SigningSessionResult> {
  if (!applicationId) return { status: "not_ready", reason: "missing_application_id" };
  const appRes = await dbQuery<{ signnow_app_signed_at: string | null; metadata: any; finalized_count: string }>(
    `SELECT a.signnow_app_signed_at, a.metadata,
            (SELECT COUNT(*) FROM application_lender_selections s
              WHERE s.application_id::text = a.id::text AND s.finalized_at IS NOT NULL) AS finalized_count
       FROM applications a WHERE a.id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const row = appRes.rows[0];
  if (!row) return { status: "not_ready", reason: "application_not_found" };
  if (row.signnow_app_signed_at) return { status: "signed" };
  if (Number(row.finalized_count ?? 0) <= 0) return { status: "not_ready", reason: "lender_not_finalized" };
  if (isStubMode() || !signnow.isApiKeyConfigured()) return { status: "stub" };

  const md = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, any>) : {};
  const inputs = await loadApplicationForPdf(applicationId);
  const email = inputs.applicantEmail;
  if (!email) return { status: "not_ready", reason: "no_applicant_email" };

  try {
    const sess = md.signnow_embedded && typeof md.signnow_embedded === "object" ? md.signnow_embedded : null;
    if (sess?.group_id && sess?.invite_id) {
      const link = await signnow.createEmbeddedGroupLink(String(sess.group_id), String(sess.invite_id), email);
      return { status: "ready", url: link.url, expiresAt: link.expiresAt };
    }
    const templateIds = await resolveTemplateIds(applicationId);
    if (templateIds.length === 0) return { status: "not_ready", reason: "no_templates_configured" };
    const docIds: string[] = [];
    for (const t of templateIds) {
      const d = await signnow.createDocumentFromTemplate(t, `app-${applicationId}`);
      docIds.push(d.documentId);
    }
    const group = await signnow.createDocumentGroup(docIds, `Boreal application ${applicationId}`);
    const invite = await signnow.createEmbeddedGroupInvite(group.groupId, { email, name: inputs.applicantName ?? undefined, roleName: SIGNER_ROLE });
    const link = await signnow.createEmbeddedGroupLink(group.groupId, invite.inviteId, email);
    await dbQuery(
      `UPDATE applications
          SET signnow_document_id = $2,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'signnow_embedded', jsonb_build_object(
                  'group_id', $2::text, 'invite_id', $3::text, 'doc_ids', $4::jsonb,
                  'created_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
              updated_at = now()
        WHERE id::text = ($1)::text`,
      [applicationId, group.groupId, invite.inviteId, JSON.stringify(docIds)],
    );
    return { status: "ready", url: link.url, expiresAt: link.expiresAt };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : "signnow_error" };
  }
}
