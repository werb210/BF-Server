import { Router, type Request } from "express";
import crypto from "node:crypto";
import { safeHandler } from "../middleware/safeHandler.js";
import { dbQuery } from "../db.js";
import { logCrmEvent } from "../modules/crm/crmTimeline.service.js";

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

    const { document_id, status, signer_email } = req.body ?? {};

    if (status !== "document_signed") {
      res.status(200).json({ received: true });
      return;
    }

    const appResult = await dbQuery<{ id: string; crm_contact_id: string | null }>(
      `select id, crm_contact_id from applications where signnow_document_id = $1 limit 1`,
      [document_id]
    );

    const app = appResult.rows[0];
    if (!app) {
      res.status(200).json({ received: true });
      return;
    }

    // BF_SERVER_BLOCK_v141_SIGNNOW_WEBHOOK_REPAIR_v1 — stamp the column
    // the orchestrator's Stage B gate reads (see v142). Without this the
    // gate would always be false even with the webhook now firing.
    await dbQuery(
      `update applications set signnow_app_signed_at = now(), updated_at = now()
        where id::text = ($1)::text`,
      [app.id]
    );

    await dbQuery(
      `update applicants set ssn = null, sin = null, updated_at = now() where application_id = $1`,
      [app.id]
    );

    await dbQuery(
      `update application_partners set ssn = null, sin = null, updated_at = now() where application_id = $1`,
      [app.id]
    );

    if (app.crm_contact_id) {
      await logCrmEvent({
        contactId: app.crm_contact_id,
        applicationId: app.id,
        eventType: "signnow_signed",
        payload: { signerEmail: signer_email, documentId: document_id },
      });
    }

    // BF_SERVER_BLOCK_v185_LENDER_PACKAGE_DEDUP_v1
    // ON CONFLICT DO NOTHING against the partial unique index from
    // migration 2026_05_06_lender_package_dedup_v185.sql. SignNow webhook
    // retries no longer cause duplicate dispatches.
    await dbQuery(
      `insert into job_queue (id, type, payload, status, created_at)
       values (gen_random_uuid(), 'send_lender_package', $1::jsonb, 'pending', now())
       on conflict ((payload->>'applicationId')) where type = 'send_lender_package' and status in ('pending','running') do nothing`,
      [JSON.stringify({ applicationId: app.id })]
    );

    res.status(200).json({ received: true, purged: true });
  })
);

export default router;
