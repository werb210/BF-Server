import { isApiKeyConfigured, ensureUserSignedSubscription } from "./signnowClient.js";

// Register (idempotently) a user-level "field invite signed" webhook so signed
// events are PUSHED to /api/webhooks/signnow. SignNow denies our API key read
// access to signed documents/groups (group GET -> 403, document GET -> 400
// "not readable"), so a pushed webhook is the only reliable completion signal.
export async function ensureSignnowWebhook(): Promise<void> {
  if (!isApiKeyConfigured()) {
    console.log("[signnow-webhook] skipped (SIGNNOW_API_KEY not configured)");
    return;
  }
  const callback =
    process.env.SIGNNOW_WEBHOOK_URL ||
    "https://server.boreal.financial/api/webhooks/signnow";
  // Document-GROUP invites do not reliably emit user.document.fieldinvite.signed,
  // so also subscribe to document.complete (the webhook handler already accepts any
  // /signed|complete/ event). Register each best-effort: an unknown event name on a
  // given SignNow plan must not block the others or crash startup.
  const events = ["user.document.fieldinvite.signed", "user.document.complete"];
  // BF_SERVER_v784_WEBHOOK_SIGNATURES - register (or update) with secret_key so SignNow
  // signs callbacks; the webhook route rejects unsigned ones.
  const secret = (process.env.SIGNNOW_WEBHOOK_SECRET ?? "").trim();
  if (!secret) {
    console.error("[signnow-webhook] SIGNNOW_WEBHOOK_SECRET unset - subscriptions will be unsigned and every callback will be rejected");
  }
  for (const ev of events) {
    try {
      const r = await ensureUserSignedSubscription(callback, ev, secret);
      console.log(`[signnow-webhook] ${r.summary}`);
    } catch (e) {
      console.error(
        `[signnow-webhook] subscription setup failed for ${ev}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
