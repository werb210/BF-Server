// BF_SERVER_MEDIA_FEE_AGREEMENT_v709 - staff view of an application's client fee
// agreement (media files sent to a lender that does not pay Boreal).
// GET /api/portal/applications/:id/fee-agreement
import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getFeeAgreement } from "../services/feeAgreement/mediaFeeAgreement.js";

const router = Router();

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
    });
  })
);

export default router;
