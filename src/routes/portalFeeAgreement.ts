// BF_SERVER_MEDIA_FEE_AGREEMENT_v709 - staff view of an application's client fee
// agreement (media files sent to a lender that does not pay Boreal).
// GET /api/portal/applications/:id/fee-agreement
import { Router } from "express";
import { dbQuery } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getFeeAgreement, sendMediaFeeAgreementNow } from "../services/feeAgreement/mediaFeeAgreement.js";

const router = Router();

// BF_SERVER_FEE_NOTICE_DELIVERY_v740 - the last few notices for this agreement, so staff see what
// actually went out (text, email, app) and why anything failed.
async function recentFeeNotices(applicationId: string): Promise<Array<{ channel: string; error: string | null; createdAt: string }>> {
  try {
    const r = await dbQuery<{ channel: string; error: string | null; created_at: string }>("SELECT channel, error, created_at FROM client_notifications WHERE application_id = $1 AND kind = 'media_fee_agreement' ORDER BY created_at DESC LIMIT 6", [applicationId]);
    return r.rows.map((x) => ({ channel: x.channel, error: x.error, createdAt: x.created_at }));
  } catch (err: any) {
    console.warn("[fee-agreement] notices_read_failed", { applicationId, message: String(err?.message ?? err) });
    return [];
  }
}

router.get(
  "/applications/:id/fee-agreement",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    const ag = await getFeeAgreement(id);
    if (!ag) { res.status(200).json({ required: false }); return; }
    res.status(200).json({
      required: true,
      status: ag.status,
      signerName: ag.signer_name,
      signerEmail: ag.signer_email,
      signerIsApplicant: ag.signer_is_applicant,
      lenderName: ag.trigger_lender_name,
      createdAt: ag.created_at,
      sentAt: ag.sent_at,
      signedAt: ag.signed_at,
      documentId: ag.document_id,
      notices: await recentFeeNotices(id),
    });
  })
);

// BF_SERVER_FEE_AGREEMENT_SEND_NOW_v731 - "Send fee agreement to client" on a Media file.
// POST /api/portal/applications/:id/fee-agreement/send   { lenderName?: string }
router.post(
  "/applications/:id/fee-agreement/send",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) { res.status(400).json({ error: "application_id_required" }); return; }
    const lenderName = typeof req.body?.lenderName === "string" && req.body.lenderName.trim() ? req.body.lenderName.trim().slice(0, 120) : null;
    try {
      const out = await sendMediaFeeAgreementNow(id, lenderName);
      if (!out.ok) {
        const msg = out.reason === "not_media" ? "Only Media files get the client fee agreement." : out.reason === "already_signed" ? "The client has already signed the fee agreement." : "Application not found.";
        res.status(out.reason === "application_not_found" ? 404 : 409).json({ error: out.reason, message: msg });
        return;
      }
      res.status(200).json({ ok: true, result: out.reason, delivery: out.delivery ?? null }); // BF_SERVER_FEE_NOTICE_DELIVERY_v740
    } catch (err: any) {
      res.status(502).json({ error: "send_failed", message: "Could not send the agreement: " + String(err?.message ?? err).slice(0, 200) });
    }
  })
);

export default router;
