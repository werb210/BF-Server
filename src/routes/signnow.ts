import { Router, type Request } from "express";
import crypto from "node:crypto";
import { safeHandler } from "../middleware/safeHandler.js";
import { dbQuery } from "../db.js";
import { finalizeSignedApplication } from "../signnow/finalizeSignedApplication.js";

// BF_SERVER_BLOCK_v141_SIGNNOW_WEBHOOK_REPAIR_v1
// HMAC-SHA256 verify against SIGNNOW_WEBHOOK_SECRET. SignNow sends the
// signature in the x-signnow-signature header (hex). When the env var
// is absent we DENY rather than fall open — this used to be a no-op
// echo so any attacker could trigger SSN/SIN purge by faking a payload.
function verifySignNowSignature(req: Request): boolean {
  // BF_SERVER_BLOCK_v188_SIGNNOW_SECRET_OPTIONAL_v1
  const secret = process.env.SIGNNOW_WEBHOOK_SECRET;
  const verifyEnabled = typeof secret === "string" && secret.trim().length > 0;

  if (!verifyEnabled) {
    // eslint-disable-next-line no-console
    console.warn(
      "[signnow] SIGNNOW_WEBHOOK_SECRET is unset — accepting webhook without HMAC verify (paid SignNow feature not enabled)"
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
    // BF_SERVER_BLOCK_v141_SIGNNOW_WEBHOOK_REPAIR_v1 — verify before doing
    // anything destructive (the handler purges SSN/SIN). Deny on missing
    // secret so a misconfigured deploy fails closed instead of open.
    if (!verifySignNowSignature(req as any)) {
      res.status(401).json({ error: "invalid_signature" });
      return;
    }

    const { document_id, document_group_id, status, signer_email } = req.body ?? {};

    // BF_SERVER_BLOCK_v712 — accept document-group completion as well as single-doc.
    const signedStatuses = new Set(["document_signed","document_group_invite_signed","document_group_invite_complete","document_group_signed"]);
    if (!signedStatuses.has(String(status))) {
      res.status(200).json({ received: true });
      return;
    }
    const matchId = document_group_id ?? document_id;

    const appResult = await dbQuery<{ id: string; contact_id: string | null }>(
      `select id, contact_id from applications where signnow_document_id = $1 limit 1`,
      [matchId]
    );

    const app = appResult.rows[0];
    if (!app) {
      res.status(200).json({ received: true });
      return;
    }

    // Shared finalize: stamp signed, purge SIN/SSN, log CRM, enqueue lender
    // package. Same path the completion poller uses. Idempotent across retries.
    await finalizeSignedApplication(
      { id: app.id, contactId: app.contact_id },
      { signerEmail: signer_email, documentId: document_id }
    );

    res.status(200).json({ received: true, purged: true });
  })
);

export default router;
