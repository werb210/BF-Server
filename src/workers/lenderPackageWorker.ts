// BF_SERVER_BLOCK_v146_LENDER_PACKAGE_WORKER_v1
// Polls job_queue for 'send_lender_package' jobs and dispatches to the
// finalized lenders for each application. FOR UPDATE SKIP LOCKED makes
// this safe under multiple replicas.

import type { Pool } from "pg";
import {
  dispatchToSelected,
  type DispatchLender,
} from "../services/lenders/dispatchToSelected.js";

const POLL_MS = Number(process.env.LENDER_PACKAGE_POLL_MS || 15000);
const BATCH = Math.max(1, Number(process.env.LENDER_PACKAGE_BATCH || 3));

type JobRow = {
  id: string;
  payload: { applicationId?: string } | null;
};

export function startLenderPackageWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const claimed = await pool.query<JobRow>(
        `WITH next_jobs AS (
           SELECT id
             FROM job_queue
            WHERE type = 'send_lender_package'
              AND status = 'pending'
              AND COALESCE(next_attempt_at, created_at) <= NOW()
            ORDER BY created_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE job_queue
            SET status = 'in_progress', updated_at = now()
          WHERE id IN (SELECT id FROM next_jobs)
          RETURNING id, payload`,
        [BATCH]
      );

      for (const job of claimed.rows) {
        const applicationId =
          job.payload && typeof job.payload.applicationId === "string"
            ? job.payload.applicationId
            : null;
        if (!applicationId) {
          await pool.query(
            `UPDATE job_queue SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
            [job.id, "missing_application_id"]
          );
          continue;
        }

        try {
          const lenders = await pool.query<DispatchLender>(
            `SELECT l.id::text AS lender_id, l.name, l.submission_method,
                    l.submission_email, l.api_endpoint, l.api_key_encrypted,
                    l.google_sheet_id
               FROM application_lender_selections s
               JOIN lenders l ON l.id::text = s.lender_id::text
              WHERE s.application_id::text = ($1)::text
                AND s.finalized_at IS NOT NULL`,
            [applicationId]
          );

          if (lenders.rows.length === 0) {
            await pool.query(
              `UPDATE job_queue SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
              [job.id, "no_finalized_lenders"]
            );
            console.warn("[lender_package_worker] no finalized lenders", { applicationId, jobId: job.id });
            continue;
          }

          await dispatchToSelected({ pool, applicationId }, lenders.rows);

          await pool.query(
            `UPDATE job_queue SET status = 'completed', updated_at = now() WHERE id = $1`,
            [job.id]
          );
          console.log("[lender_package_worker] dispatched", {
            applicationId, jobId: job.id, lenderCount: lenders.rows.length,
          });
        } catch (err) {
          // BF_SERVER_BLOCK_v174_WORKER_RETRY_BACKOFF_v1
          // Increment attempts; if at max, mark dead. Otherwise reschedule
          // with exponential backoff: attempt 1 -> 1m, 2 -> 5m, 3 -> 15m.
          const msg = err instanceof Error ? err.message : String(err);
          await pool
            .query(
              `UPDATE job_queue
                  SET attempts = attempts + 1,
                      error = $2,
                      status = CASE
                        WHEN attempts + 1 >= COALESCE(max_attempts, 3) THEN 'failed'
                        ELSE 'pending'
                      END,
                      next_attempt_at = NOW() + (
                        CASE attempts
                          WHEN 0 THEN INTERVAL '1 minute'
                          WHEN 1 THEN INTERVAL '5 minutes'
                          ELSE INTERVAL '15 minutes'
                        END
                      ),
                      updated_at = NOW()
                WHERE id = $1`,
              [job.id, msg.slice(0, 500)]
            )
            .catch(() => {});
          console.error("[lender_package_worker] dispatch failed", {
            applicationId, jobId: job.id, error: msg,
          });
        }
      }
    } catch (err) {
      console.error("[lender_package_worker] tick error", {
        error: err instanceof Error ? err.message : String(err),
      });
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
