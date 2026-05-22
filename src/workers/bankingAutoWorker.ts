// BF_SERVER_BLOCK_1_30B_BANKING_WORKER_TRIGGER
// Polls for applications whose bank-statement documents are OCR-ready
// and triggers the Document-Intelligence-backed banking analysis
// pipeline (see src/services/banking/bankingAnalysisPipeline.ts).
import type { Pool } from "pg";
import { eventBus } from "../events/eventBus.js";
import { runBankingAnalysis } from "../services/banking/bankingAnalysisPipeline.js";
import { getStorage } from "../lib/storage/index.js";

const POLL_MS = Number(process.env.BANKING_AUTO_POLL_MS || 15000);
const BATCH = Math.max(1, Number(process.env.BANKING_AUTO_BATCH || 3));

async function fetchBuffer(storageKey: string): Promise<Buffer> {
  const storage = getStorage();
  const got = await storage.get(storageKey);
  if (!got) throw new Error(`storage_object_missing:${storageKey}`);
  return got.buffer;
}

export function startBankingAutoWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // BF_SERVER_BLOCK_v177_BANKING_WORKER_RETRY_v1
      // Exclude 'in_progress' and 'analysis_complete' as before; also
      // skip 'failed' rows that are still in their backoff window AND
      // 'failed' rows that have hit max_attempts.
      const { rows } = await pool.query<{ application_id: string }>(
        `SELECT DISTINCT d.application_id::text AS application_id
           FROM documents d
          JOIN applications app ON app.id = d.application_id
          WHERE LOWER(COALESCE(d.signed_category, d.document_type, '')) LIKE '%bank%'
            AND COALESCE((app.metadata->>'banking_auto_skip')::boolean, false) IS NOT TRUE
            AND d.ocr_status = 'completed'
            AND NOT EXISTS (
              SELECT 1 FROM banking_analyses ba
               WHERE ba.application_id = d.application_id
                 AND (
                      ba.status IN ('in_progress', 'analysis_complete')
                   OR (ba.status = 'failed' AND ba.next_attempt_at > NOW())
                   OR (ba.status = 'failed' AND ba.attempt_count >= COALESCE(ba.max_attempts, 3))
                 )
            )
          LIMIT $1`,
        [BATCH]
      );

      for (const row of rows) {
        const applicationId = row.application_id;
        try {
          await runBankingAnalysis(applicationId, { fetchBuffer });

          // Mirror banking_status onto each bank document so any
          // consumer still relying on the per-doc flag sees completion.
          await pool.query(
            `UPDATE documents
                SET banking_status = 'completed', updated_at = now()
              WHERE application_id::text = ($1)::text
                AND LOWER(COALESCE(signed_category, document_type, '')) LIKE '%bank%'`,
            [applicationId]
          );

          eventBus.emit("banking_completed", { applicationId });
          console.log("[banking_auto_worker] analysis complete", { applicationId });
        } catch (err) {
          console.error("[banking_auto_worker] analysis failed", {
            applicationId,
            error: err instanceof Error ? err.message : String(err),
          });
          // BF_SERVER_BLOCK_v177_BANKING_WORKER_RETRY_v1
          // Increment attempt_count + set next_attempt_at via exponential
          // backoff (5m, 15m, 30m). After max_attempts the row stays
          // 'failed' and the SELECT exclusion keeps the worker from
          // looping on it again.
          const errMsg = err instanceof Error ? err.message : String(err);
          await pool
            .query(
              `INSERT INTO banking_analyses
                 (application_id, status, attempt_count, max_attempts,
                  next_attempt_at, last_error, updated_at)
               VALUES ($1, 'failed', 1, 3,
                       NOW() + INTERVAL '5 minutes', $2, NOW())
               ON CONFLICT (application_id) DO UPDATE
                 SET status = 'failed',
                     attempt_count = banking_analyses.attempt_count + 1,
                     next_attempt_at = NOW() + (
                       CASE banking_analyses.attempt_count
                         WHEN 0 THEN INTERVAL '5 minutes'
                         WHEN 1 THEN INTERVAL '15 minutes'
                         ELSE INTERVAL '30 minutes'
                       END
                     ),
                     last_error = EXCLUDED.last_error,
                     updated_at = NOW()`,
              [applicationId, errMsg.slice(0, 500)]
            )
            .catch(() => {});
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => {});
  }, POLL_MS);
  tick().catch(() => {});

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    process.removeListener("SIGTERM", stop);
  };
  process.on("SIGTERM", stop);
  return { stop };
}
