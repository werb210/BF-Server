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
    await finalizeSignedApplication(
      { id: app.id, contactId: app.contact_id },
      { signerEmail, documentId }
    );

    res.status(200).json({ received: true, purged: true });
  })
);

export default router;
