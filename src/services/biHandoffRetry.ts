// BF_SERVER_BI_HANDOFF_RETRY_v397
// Automatically retries submitted, PGI-opted BF applications that do not yet
// have a BI link. BI keys handoffs on the BF application id, making retries
// idempotent.
import { pool } from "../db.js";
import { postBiHandoff } from "./biHandoff.js";
import { mirrorApplicationDocsToBi } from "./biDocMirror.js";

export const MAX_ATTEMPTS = 12;

export type PendingHandoff = { id: string; form: any };

export type RetryDeps = {
  findPending: (limit: number) => Promise<PendingHandoff[]>;
  send: typeof postBiHandoff;
  recordSuccess: (id: string, result: { biApplicationId?: string | null; biPublicId?: string | null; completionUrl?: string | null }) => Promise<void>;
  recordFailure: (id: string, error: string) => Promise<void>;
  mirrorDocs: (id: string) => Promise<unknown>;
};

async function findPending(limit: number): Promise<PendingHandoff[]> {
  const result = await pool.query<{ id: string; form: any }>(
    `SELECT id::text AS id, metadata->'formData' AS form
       FROM applications
      WHERE silo = 'BF'
        AND bi_application_id IS NULL
        AND metadata->>'bi_link_cleared_at' IS NULL -- BF_SERVER_BI_UNLINK_DELETED_v404: deleted in BI on purpose
        AND metadata->>'submittedAt' IS NOT NULL
        AND jsonb_typeof(metadata->'formData') = 'object'
        AND lower(COALESCE(metadata->'formData'->>'pgi_opt_in', metadata->>'pgi_opt_in', '')) = 'yes'
        AND COALESCE((metadata->>'bi_handoff_attempts')::int, 0) < $2
        AND (metadata->>'bi_handoff_last_attempt_at' IS NULL
             OR (metadata->>'bi_handoff_last_attempt_at')::timestamptz < now() - interval '30 minutes')
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit, MAX_ATTEMPTS],
  );
  return result.rows;
}

async function recordSuccess(id: string, result: { biApplicationId?: string | null; biPublicId?: string | null; completionUrl?: string | null }): Promise<void> {
  await pool.query(
    `UPDATE applications
        SET bi_application_id = $1, bi_public_id = $2, bi_completion_url = $3,
            metadata = COALESCE(metadata, '{}'::jsonb) - 'bi_handoff_last_error'
                       || jsonb_build_object('bi_handoff_retried_at', now()::text),
            updated_at = NOW()
      WHERE id::text = $4`,
    [result.biApplicationId ?? null, result.biPublicId ?? null, result.completionUrl ?? null, id],
  );
}

async function recordFailure(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE applications
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'bi_handoff_attempts', COALESCE((metadata->>'bi_handoff_attempts')::int, 0) + 1,
              'bi_handoff_last_attempt_at', now()::text,
              'bi_handoff_last_error', left($2, 300))
      WHERE id::text = $1`,
    [id, error],
  );
}

const defaultDeps: RetryDeps = {
  findPending,
  send: postBiHandoff,
  recordSuccess,
  recordFailure,
  mirrorDocs: mirrorApplicationDocsToBi,
};

export async function retryMissingBiHandoffs(limit = 20, deps: RetryDeps = defaultDeps): Promise<{ tried: number; linked: number; failed: number }> {
  const pending = await deps.findPending(limit);
  let linked = 0;
  let failed = 0;
  for (const application of pending) {
    try {
      const result = await deps.send({ bfApplicationId: application.id, legacyApp: application.form });
      if (result.ok) {
        await deps.recordSuccess(application.id, result);
        await deps.mirrorDocs(application.id);
        linked += 1;
      } else {
        await deps.recordFailure(application.id, result.error);
        failed += 1;
      }
    } catch (error) {
      await deps.recordFailure(application.id, error instanceof Error ? error.message : String(error))
        .catch((recordError) => console.warn("[bi_handoff_retry] could not record failure", recordError instanceof Error ? recordError.message : String(recordError)));
      failed += 1;
    }
  }
  if (pending.length) console.log("[bi_handoff_retry]", JSON.stringify({ tried: pending.length, linked, failed }));
  return { tried: pending.length, linked, failed };
}

const TICK_MS = 10 * 60_000;

export function startBiHandoffRetryWorker(): { stop: () => void } {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await retryMissingBiHandoffs();
    } catch (error) {
      console.warn("[bi_handoff_retry] tick failed", error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void tick(); }, 90_000);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  first.unref?.();
  timer.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}
