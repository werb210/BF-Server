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
      // Find applications eligible for banking analysis: at least one
      // bank-statement document is OCR-complete, and there is no
      // banking_analyses row in 'in_progress' or 'analysis_complete'.
      const { rows } = await pool.query<{ application_id: string }>(
        `SELECT DISTINCT d.application_id::text AS application_id
           FROM documents d
          WHERE LOWER(COALESCE(d.signed_category, d.document_type, '')) LIKE '%bank%'
            AND d.ocr_status = 'completed'
            AND NOT EXISTS (
              SELECT 1 FROM banking_analyses ba
               WHERE ba.application_id = d.application_id
                 AND ba.status IN ('in_progress', 'analysis_complete')
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
          // Park the analysis row in 'failed' so we don't loop on it.
          await pool
            .query(
              `INSERT INTO banking_analyses (application_id, status, updated_at)
                 VALUES ($1, 'failed', now())
                 ON CONFLICT (application_id) DO UPDATE
                   SET status = 'failed', updated_at = now()`,
              [applicationId]
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
