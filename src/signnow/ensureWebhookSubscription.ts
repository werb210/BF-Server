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
  try {
    const r = await ensureUserSignedSubscription(callback);
    console.log(`[signnow-webhook] ${r.summary}`);
  } catch (e) {
    console.error(
      `[signnow-webhook] subscription setup failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
