import type { Pool } from "pg";
import * as signnow from "../signnow/signnowClient.js";
import { finalizeSignedApplication } from "../signnow/finalizeSignedApplication.js";

// Embedded signing has no SignNow webhook subscription, so the signed event
// never reaches /webhooks/signnow. This poller checks in-flight signings
// (signnow_document_id set, signnow_app_signed_at null) against the live
// SignNow document-group status and runs the same finalize the webhook would.
const POLL_MS = Math.max(5000, Number(process.env.SIGNNOW_POLL_MS || 20000));
const BATCH = Math.max(1, Number(process.env.SIGNNOW_POLL_BATCH || 5));

type Row = { id: string; contact_id: string | null; signnow_document_id: string };

export function startSignNowCompletionPoller(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    if (!signnow.isApiKeyConfigured()) return;
    running = true;
    try {
      const rows = await pool.query<Row>(
        `SELECT id, contact_id, signnow_document_id
           FROM applications
          WHERE signnow_document_id IS NOT NULL
            AND signnow_app_signed_at IS NULL
            AND updated_at > now() - interval '30 days'
          ORDER BY updated_at DESC
          LIMIT $1`,
        [BATCH]
      );
      for (const app of rows.rows) {
        try {
          const status = await signnow.getDocumentGroupStatus(app.signnow_document_id);
          if (status.signed) {
            const fired = await finalizeSignedApplication(
              { id: app.id, contactId: app.contact_id },
              { documentId: app.signnow_document_id }
            );
            if (fired) {
              console.log(`[signnow-poll] app=${app.id} signed (${status.summary}) — enqueued lender package`);
            }
          }
        } catch (e) {
          console.warn(`[signnow-poll] check failed app=${app.id} group=${app.signnow_document_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      console.warn(`[signnow-poll] tick error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, POLL_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
