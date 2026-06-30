// BF_SERVER_BLOCK_v712_EMBEDDED_GROUP_SIGNING_v1
// BF_SERVER_BLOCK_v203_SIGNNOW_ACCORD_GROUP_v1
import { dbQuery } from "../db.js";
import { loadApplicationForPdf } from "./sendApplicationForSignature.js";
import { buildApplicationPdf } from "./pdfBuilder.js";
import { buildAccordPdf } from "./accordPdfBuilder.js";
import { uploadSignedApplicationPdf } from "./blobStorage.js";
import * as signnow from "./signnowClient.js";
import { pnwSigningSatisfiedForAppSigning } from "./pnwSigning.js";
import { sendViaGraph } from "../services/email/graphSendService.js";

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
        -- BF_SERVER_BLOCK_v_ACCORD_LOC_CATEGORY_FIX_v1 — applications.product_category stores the
        -- RAW wizard value ('LINE_OF_CREDIT'), never the normalized 'LOC' that lender_products.category
        -- holds. The old '= LOC' check was therefore always false for real Accord LOC apps, so the
        -- Accord credit application was never uploaded to the signing group (1-doc group) and so never
        -- reached the lender package. Accept both spellings (normalizeProductCategory maps them equal).
        AND upper(coalesce(a.product_category, '')) IN ('LOC', 'LINE_OF_CREDIT')`, [applicationId]).catch(() => ({ rows: [{ n: "0" }] }));
  return Number(res.rows[0]?.n ?? 0) > 0;
}

// BF_SERVER_BLOCK_v_ACCORD_GROUP_REFRESH_v1 — a cached signing group is reused as-is.
// If it was minted before the Accord LOC lender was finalized (or before buildAccordPdf
// succeeded), it holds only the Boreal app, so the Accord form never reaches the signing
// group OR the lender package. Regenerate when Accord is finalized but the cached group
// has fewer than two docs (i.e. no Accord form). Pure + tested.
export function accordGroupNeedsRefresh(accordFinalized: boolean, cachedDocCount: number): boolean {
  return accordFinalized && cachedDocCount < 2;
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
  // BF_SERVER_BLOCK_PNW_ORDER_GATE_v2 — the Personal Net Worth statement must be
  // signed (its own envelope) BEFORE the application signing session may open.
  if (!(await pnwSigningSatisfiedForAppSigning(applicationId))) return { status: "not_ready", reason: "pnw_not_signed" };
  if (isStubMode()) return { status: "stub", reason: "SIGNNOW_STUB_MODE is enabled on this server" };
  if (!signnow.isApiKeyConfigured()) return { status: "stub", reason: "SIGNNOW_API_KEY is empty on this server" };

  try {
    const md = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, any>) : {};
    const inputs = await loadApplicationForPdf(applicationId);
    // BF_SERVER_BLOCK_v_SIGN_DOC_NAMES_v1 — name minted docs/group by business + date
    // so they are findable in the SignNow UI instead of "app-<uuid>".
    const _bizName = (inputs.business?.legalName || inputs.business?.dba || inputs.applicantName || "Boreal application").toString().slice(0, 60);
    const _stamp = new Date().toISOString().slice(0, 10);
    const _docLabel = `${_bizName} — ${_stamp}`;
    const email = inputs.applicantEmail;
    if (!email) return { status: "not_ready", reason: "no_applicant_email" };

    const sess = md.signnow_embedded && typeof md.signnow_embedded === "object" ? md.signnow_embedded : null;
    // BF_SERVER_BLOCK_v_ACCORD_GROUP_REFRESH_v1 — never reuse a cached group that is
    // missing the Accord form while Accord is finalized; fall through to regenerate it.
    const cachedDocIds = Array.isArray(sess?.doc_ids) ? (sess!.doc_ids as unknown[]) : [];
    const needsAccordRefresh = accordGroupNeedsRefresh(await isAccordFinalized(applicationId), cachedDocIds.length);
    if (sess?.group_id && sess?.invite_id && !needsAccordRefresh) {
      try {
        // BF_SERVER_BLOCK_v_SIGNING_SESSION_PERSIGNER_v1 — if THIS applicant has
        // already signed their invite (group still open for partners), do NOT
        // re-open their consumed embedded link (which 401s into SignNow's login
        // page). Report "signed" so the CMP shows the signed state for them.
        try {
          if (await signnow.getSignerInviteComplete(String(sess.group_id), email)) {
            return { status: "signed" };
          }
        } catch { /* status check is best-effort; fall through to link */ }
        const link = await signnow.createEmbeddedGroupLink(String(sess.group_id), String(sess.invite_id), email);
        return { status: "ready", url: link.url, expiresAt: link.expiresAt };
      } catch (e) {
        // 19001041 / "different application" / "denied" / "not readable" (65610)
        // all mean the stored group belongs to a different SignNow app — orphaned
        // by an API-key/app rotation. We can't relink or read it. Surface a soft
        // "stale" state instead of a raw error (the CMP shows a calm message). We
        // do NOT auto-recreate: we can't tell from an unreadable group whether it
        // was already signed, and recreating would wrongly re-prompt a signed app.
        // If it was signed, staff run the admin mark-signed route to finalize.
        const m = e instanceof Error ? e.message : String(e);
        // BF_SERVER_BLOCK_v_SIGN_REINVITE_EXPIRED_v1 — 19001037 / "does not have an active
        // invitation" means the cached invite EXPIRED. The group is still readable with the
        // current key (and we already returned "signed" above if this signer had signed), so
        // re-minting a fresh group is safe — it is exactly what a re-send should do.
        if (/19001041|19001037|active invitation|different|denied|not readable|65610|access/i.test(m)) {
          // The stored group is orphaned by an API-key/app rotation: it can never
          // be relinked, read, or downloaded with the current key, so it is dead
          // weight regardless of whether it was signed under the old key. The app
          // is NOT recorded as signed (we returned "signed" earlier otherwise), and
          // the old group is unrecoverable anyway, so leaving the client on a stale
          // session strands the deal. Fall through and mint a FRESH group with the
          // current key so the client can sign and the package can move.
          console.warn(`[signnow] orphaned signing group for app=${applicationId} (${m}); regenerating a fresh signing session`);
          // intentional fall-through to fresh-session creation below
        } else {
          throw e;
        }
      }
    }

    const docIds: string[] = [];
    // v_SIGNNOW_DATE_STAMP: capture the builder's date anchors so the real signing date
    // can be stamped per document after completion (SignNow can't auto-fill a date field).
    const dateAnchorsByDoc: Record<string, import("./pdfBuilder.js").DateAnchor[]> = {};
    const borealAnchorsOut = { dateAnchors: [] as import("./pdfBuilder.js").DateAnchor[] };
    const borealPdf = await buildApplicationPdf(inputs, borealAnchorsOut);
    // BF_SERVER_SIGNNOW_GROUP_BLOB_v1 — persist the formatted application PDF to blob so the
    // lender package keeps the real PDF (loadSignedApplicationPdf reads signed_application_blob_name;
    // without this it falls back to a plain-text field dump).
    let blobName: string | null = null;
    let blobUrl: string | null = null;
    try { const up = await uploadSignedApplicationPdf(applicationId, Buffer.from(borealPdf)); blobName = up.blobName; blobUrl = up.url; } catch { /* non-fatal: lender package falls back to text render */ }
    const boreal = await signnow.uploadDocumentWithFieldExtract(borealPdf, `${_docLabel}.pdf`);
    docIds.push(boreal.documentId);
    dateAnchorsByDoc[boreal.documentId] = borealAnchorsOut.dateAnchors;

    if (await isAccordFinalized(applicationId)) {
      try {
        const accordPdf = await buildAccordPdf(applicationId);
        const accord = await signnow.uploadDocumentWithFieldExtract(accordPdf, `${_docLabel} (Accord Credit Application).pdf`);
        docIds.push(accord.documentId);
        // Accord's date box is a fixed-position template field (page 0, native coords).
        dateAnchorsByDoc[accord.documentId] = [{ role: "Owner 1", page: 0, x: 440, y: 108 }];
      } catch (e) {
        console.warn(`[signnow] Accord form skipped for app=${applicationId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const group = await signnow.createDocumentGroup(docIds, _docLabel);
    // BF_SERVER_BLOCK_v_MULTISIGNER_STEPS_v1 — Owner 2 is a real second signer whenever the
    // application has a second owner with an email, INCLUDING when it equals the applicant's
    // (co-owners who share an inbox). The same email is valid as long as the two signers sit
    // in SEPARATE invite steps, which createEmbeddedGroupInvite now enforces (one signer per
    // sequential step). Keeping both signers also keeps the PDF's Owner 2 role filled, so the
    // invite no longer fails with "Role Owner 2 was not specified".
    const o2 = inputs.owners[1];
    const o2email = (o2?.email ?? "").trim();
    const o2present = o2email.length > 0;
    const o2name = o2present ? ([o2!.firstName, o2!.lastName].filter(Boolean).join(" ").trim() || undefined) : undefined;
    const signers: signnow.EmbeddedSigner[] = [{ email, name: inputs.applicantName ?? undefined, roleName: ROLE_OWNER1 }];
    if (o2present) signers.push({ email: o2email, name: o2name, roleName: ROLE_OWNER2 });

    const invite = await signnow.createEmbeddedGroupInvite(group.groupId, docIds, signers);
    const link = await signnow.createEmbeddedGroupLink(group.groupId, invite.inviteId, email);

    if (o2present) {
      try {
        const o2link = await signnow.createEmbeddedGroupLink(group.groupId, invite.inviteId, o2email);
        const greeting = o2name ? `Hi ${o2name},` : "Hello,";
        const sent = await sendViaGraph({
          to: o2email,
          subject: "Your Boreal application is ready to sign",
          bodyHtml: `<p>${greeting}</p><p>An application you are listed on as an owner is ready for your signature. Please review and sign using your secure link below:</p><p><a href="${o2link.url}">Review &amp; sign your application</a></p><p>This link is unique to you. If you weren't expecting this, you can safely ignore this email.</p>`,
          bodyText: `${greeting}\n\nAn application you are listed on as an owner is ready for your signature. Please review and sign using your secure link:\n${o2link.url}\n\nThis link is unique to you.`,
        });
        if (!sent.ok) {
          // BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_v1 — a swallowed partner-invite
          // failure now DEADLOCKS the package (all-signers gate). Persist a
          // visible signal so staff can resend rather than the app stalling silently.
          console.error(`[signnow] PARTNER INVITE FAILED app=${applicationId}: ${sent.error}`);
          await dbQuery(
            `update applications set metadata = coalesce(metadata,'{}'::jsonb)
               || jsonb_build_object('partner_invite_error', $2::text,
                                     'partner_invite_error_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
             where id::text = ($1)::text`,
            [applicationId, String(sent.error).slice(0,400)]
          ).catch(() => {});
        }
      } catch (e) {
        console.warn(`[signnow] failed to email Owner 2 signing link for app=${applicationId}: ${e instanceof Error ? e.message : String(e)}`);
      }
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
                    'created_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))
                || jsonb_build_object('signnow_date_anchors', $7::jsonb),
              updated_at = now()
        WHERE id::text = ($1)::text`,
      [applicationId, group.groupId, invite.inviteId, JSON.stringify(docIds), blobName, blobUrl, JSON.stringify(dateAnchorsByDoc)]);
    return { status: "ready", url: link.url, expiresAt: link.expiresAt };
  } catch (err) {
    console.error(`[signnow] signing-session error app=${applicationId}:`, err instanceof Error ? (err.stack ?? err.message) : err);
    return { status: "error", reason: err instanceof Error ? err.message : "signnow_error" };
  }
}
