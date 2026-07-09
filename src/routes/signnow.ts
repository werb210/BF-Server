import { Router, type Request } from "express";
import crypto from "node:crypto";
import { safeHandler } from "../middleware/safeHandler.js";
import { dbQuery } from "../db.js";
import { finalizeSignedApplication } from "../signnow/finalizeSignedApplication.js";
import { attachSignedPnwDocument } from "../signnow/pnwSigning.js";
import { attachSignedTermSheet } from "../services/signnow/sendOfferTermSheet.js"; // BF_SERVER_OFFER_TERMSHEET_SIGNING_v1
import { transitionPipelineState } from "../modules/applications/applications.service.js"; // BF_SERVER_OFFER_TERMSHEET_SIGNING_v1
import { notifyAllStaff } from "../services/notifications/notifyAllStaff.js"; // BF_SERVER_OFFER_TERMSHEET_SIGNING_v1
import { pool } from "../db.js"; // BF_SERVER_OFFER_TERMSHEET_SIGNING_v1

// BF_SERVER_BLOCK_v141_SIGNNOW_WEBHOOK_REPAIR_v1
// HMAC-SHA256 verify against SIGNNOW_WEBHOOK_SECRET. SignNow sends the
// signature in the x-signnow-signature header (hex). When the env var
// is absent we DENY rather than fall open - this used to be a no-op
// echo so any attacker could trigger SSN/SIN purge by faking a payload.
function verifySignNowSignature(req: Request): boolean {
  // BF_SERVER_BLOCK_v188_SIGNNOW_SECRET_OPTIONAL_v1
  const secret = process.env.SIGNNOW_WEBHOOK_SECRET;
  const verifyEnabled = typeof secret === "string" && secret.trim().length > 0;

  if (!verifyEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      "[signnow] SIGNNOW_WEBHOOK_SECRET is unset - accepting webhook without HMAC verify (paid SignNow feature not enabled)"
    );
    return true;
  }

  const sig = req.header("x-signnow-signature");
  if (!sig || typeof sig !== "string") return false;
  const raw = (req as any).rawBody;
  if (!raw || !Buffer.isBuffer(raw)) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
  } catch {
    return false;
  }
}

const router = Router();

router.post(
  "/webhooks/signnow",
  safeHandler(async (req: any, res: any) => {
    // BF_SERVER_BLOCK_v141_SIGNNOW_WEBHOOK_REPAIR_v1 - verify before doing
    // anything destructive (the handler purges SSN/SIN). Deny on missing
    // secret so a misconfigured deploy fails closed instead of open.
    if (!verifySignNowSignature(req as any)) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    const b: any = req.body ?? {};
    try { console.log("[signnow-webhook] raw:", JSON.stringify(b).slice(0, 1500)); } catch { /* ignore */ }

    // SignNow payloads vary (flat vs nested under meta/content/data). Search the
    // common containers for ids and the event/status signal.
    const nests = [b, b.content, b.data, b.meta, b.meta?.content].filter(
      (x: any) => x && typeof x === "object",
    );
    const grab = (keys: string[]): string | null => {
      for (const n of nests) for (const k of keys) {
        const v = n[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return null;
    };
    const eventName = (grab(["event", "event_name", "event_type"]) ?? "").toLowerCase();
    const status = (grab(["status"]) ?? "").toLowerCase();
    const documentId = grab(["document_id", "documentId", "doc_id", "docid"]);
    const documentGroupId = grab(["document_group_id", "documentGroupId", "group_id", "documentgroup_id"]);
    const signerEmail = grab(["signer_email", "email"]);

    // Accept either an explicit signed status or a signing event name (e.g.
    // user.document.fieldinvite.signed, document.complete, document_group...completed).
    const signedStatuses = new Set(["document_signed","document_group_invite_signed","document_group_invite_complete","document_group_signed"]);
    const isSigningEvent = signedStatuses.has(status) || /signed|complete/.test(eventName);
    if (!isSigningEvent) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    // BF_SERVER_REFERRER_SIGNUP_v1 - referrer agreement signed. If the group id
    // matches a pending referrer agreement, flip them to active and stop (this
    // is not an application signature). Idempotent: repeated webhooks no-op.
    if (documentGroupId || documentId) {
      const rIds = [documentGroupId, documentId].filter(Boolean) as string[];
      const refMatch = await dbQuery<{ id: string }>(
        `select id::text as id from users
          where role = 'Referrer'
            and (agreement_document_group_id = any($1::text[]) or agreement_document_id = any($1::text[]))
          limit 1`,
        [rIds],
      );
      if (refMatch.rows[0]) {
        await dbQuery(
          `update users set referrer_status='active',
                 agreement_signed_at=coalesce(agreement_signed_at, now()), updated_at=now()
            where id::text = $1`,
          [refMatch.rows[0].id],
        );
        console.log("[signnow-webhook] referrer_agreement_signed", { referrerId: refMatch.rows[0].id });
        res.status(200).json({ received: true, match: "referrer" });
        return;
      }
    }

    // BF_SERVER_PNW_ATTACH_v1 - Personal Net Worth signed. PNW uses its own
    // single-document SignNow envelope, separate from application signing.
    // Attach the signed PDF to the application's Documents list and stop here.
    if (documentGroupId || documentId) {
      const pnwIds = [documentGroupId, documentId].filter(Boolean) as string[];
      const pnwMatch = await dbQuery<{ id: string }>(
        `select id::text as id from applications
          where metadata->'pnw_signnow'->>'group_id' = any($1::text[])
             or metadata->'pnw_signnow'->>'doc_id'   = any($1::text[])
          limit 1`,
        [pnwIds],
      );
      if (pnwMatch.rows[0]) {
        const result = await attachSignedPnwDocument(pnwMatch.rows[0].id);
        console.log("[signnow-webhook] pnw_signed_attach", { applicationId: pnwMatch.rows[0].id, ...result });
        res.status(200).json({ received: true, match: "pnw", attached: result.attached });
        return;
      }
    }

    // BF_SERVER_OFFER_TERMSHEET_SIGNING_v1 - signed lender term sheet.
    if (documentGroupId || documentId) {
      const offerIds = [documentGroupId, documentId].filter(Boolean) as string[];
      const offerMatch = await dbQuery<{ id: string }>(
        `select id::text as id from applications
          where metadata->'offer_signnow'->>'group_id' = any($1::text[])
             or metadata->'offer_signnow'->>'doc_id'   = any($1::text[])
          limit 1`,
        [offerIds],
      );
      if (offerMatch.rows[0]) {
        const applicationId = offerMatch.rows[0].id;
        const attach = await attachSignedTermSheet(pool, applicationId);
        try {
          await transitionPipelineState({ applicationId, nextState: "Accepted", actorUserId: null, actorRole: null, trigger: "offer_term_sheet_signed" });
        } catch (e) { console.warn("[signnow-webhook] offer stage transition failed", e instanceof Error ? e.message : String(e)); }
        try {
          await notifyAllStaff({ pool, notificationType: "offer_term_sheet_signed", title: "Term sheet signed", body: `A client signed their term sheet (application ${applicationId}).`, refTable: "applications", refId: applicationId, contextUrl: `/applications/${applicationId}` });
        } catch (e) { console.warn("[signnow-webhook] offer notify failed", e instanceof Error ? e.message : String(e)); }
        console.log("[signnow-webhook] offer_term_sheet_signed", { applicationId, ...attach });
        res.status(200).json({ received: true, match: "offer_term_sheet", attached: attach.attached });
        return;
      }
    }

    // Match by group id or document id against signnow_document_id, then fall
    // back to the embedded doc_ids array stored at signing time.
    const ids = [documentGroupId, documentId].filter(Boolean) as string[];
    let app: { id: string; contact_id: string | null } | undefined;
    if (ids.length) {
      const r = await dbQuery<{ id: string; contact_id: string | null }>(
        `select id, contact_id from applications where signnow_document_id = any($1::text[]) limit 1`,
        [ids]
      );
      app = r.rows[0];
    }
    if (!app && documentId) {
      const r = await dbQuery<{ id: string; contact_id: string | null }>(
        `select id, contact_id from applications
           where metadata->'signnow_embedded'->'doc_ids' @> $1::jsonb limit 1`,
        [JSON.stringify([documentId])]
      );
      app = r.rows[0];
    }
    if (!app) {
      console.warn(`[signnow-webhook] no app match (group=${documentGroupId ?? "-"} doc=${documentId ?? "-"} event=${eventName || status})`);
      res.status(200).json({ received: true, matched: false });
      return;
    }

    // Shared finalize: stamp signed, purge SIN/SSN, log CRM, enqueue lender
    // package. Same path the completion poller uses. Idempotent across retries.
    // BF_SERVER_BLOCK_v_SIGNING_HARDENING_v1 - finalize (stamp signed, purge SIN, enqueue
    // lender package) ONLY when the whole group is complete. A per-signer event
    // (user.document.fieldinvite.signed) must NOT finalize a multi-owner app before the
    // co-owner has signed. If the group status is unreadable, fall back to finalizing so
    // the single-signer happy path is never blocked.
    const groupIdForStatus = documentGroupId
      ?? (await dbQuery<{ gid: string | null }>(
            `select coalesce(signnow_document_id, metadata->'signnow_embedded'->>'group_id') as gid from applications where id::text = ($1)::text limit 1`,
            [app.id]).then((r) => r.rows[0]?.gid ?? null).catch(() => null));
    let groupComplete = true;
    if (groupIdForStatus) {
      try {
        const { getDocumentGroupStatus } = await import("../signnow/signnowClient.js");
        groupComplete = (await getDocumentGroupStatus(String(groupIdForStatus))).signed;
      } catch { groupComplete = true; }
    }
    if (!groupComplete) {
      console.log(`[signnow-webhook] app=${app.id} signer signed but group not complete - waiting for other signers`);
      res.status(200).json({ received: true, waiting_for_other_signers: true });
      return;
    }

    await finalizeSignedApplication(
      { id: app.id, contactId: app.contact_id },
      { signerEmail, documentId }
    );

    res.status(200).json({ received: true, purged: true });
  })
);

export default router;
