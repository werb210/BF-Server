// BF_SERVER_v846_FRAUD - the fraud worker. Every minute (one instance at a time, via claimedTick):
//  1. queues applications that have something new: an unscanned document, fresh banking results, a submission
//  2. runs the checks for up to FRAUD_BATCH queued applications (src/fraud/engine.ts)
//  3. shares confirmed fraud with the Keystone watchlist / withdraws restored files (only when an Admin opted in)
//  4. tells Admins about new inside-job events
import type { Pool } from "pg";
import { claimedTick } from "./claim.js";
import type { Q } from "../fraud/types.js";
import { runFraudChecks, loadProfile, type EngineDeps } from "../fraud/engine.js";
import { getFraudSettings } from "../fraud/store.js";
import { alertAdmins } from "../fraud/insider.js";
import { applicationRef, watchlistEntries, watchlistReady } from "../fraud/watchlist.js";
import { accountNumbersFor } from "../fraud/network.js";
import { postToOps, type OpsFetch } from "../fraud/opsLink.js";

const TICK_MS = 60_000;
export const FRAUD_BATCH = 5;

/** Step 1: put applications with something new on the queue. Returns how many were queued or re-queued. */
export async function queueNewWork(db: Q): Promise<number> {
  const docs = await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason)
     SELECT DISTINCT d.application_id::text, now(), 'new_document'
       FROM documents d LEFT JOIN document_fingerprints f ON f.document_id = d.id::text
      WHERE f.document_id IS NULL AND d.created_at > now() - interval '60 days' AND COALESCE(d.uploaded_by, '') <> 'system'
      LIMIT 50
     ON CONFLICT (application_id) DO UPDATE SET requested_at = now(), reason = 'new_document'
      WHERE fraud_queue.done_at IS NOT NULL AND fraud_queue.done_at >= fraud_queue.requested_at
     RETURNING application_id`,
    [],
  );
  const banking = await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason)
     SELECT b.application_id::text, now(), 'banking'
       FROM banking_analyses b LEFT JOIN fraud_queue q ON q.application_id = b.application_id::text
      WHERE b.status = 'analysis_complete' AND b.updated_at > now() - interval '60 days'
        AND (q.application_id IS NULL OR (q.done_at IS NOT NULL AND q.done_at >= q.requested_at AND b.updated_at > q.done_at))
      LIMIT 50
     ON CONFLICT (application_id) DO UPDATE SET requested_at = now(), reason = 'banking'
     RETURNING application_id`,
    [],
  );
  const submitted = await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason)
     SELECT a.id::text, now(), 'submitted'
       FROM applications a LEFT JOIN fraud_queue q ON q.application_id = a.id::text
      WHERE q.application_id IS NULL AND a.submitted_at IS NOT NULL AND a.submitted_at > now() - interval '60 days'
      LIMIT 50
     ON CONFLICT (application_id) DO NOTHING
     RETURNING application_id`,
    [],
  );
  const staff = await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason)
     SELECT DISTINCT e.application_id, now(), 'staff_event'
       FROM staff_risk_events e JOIN fraud_queue q ON q.application_id = e.application_id
      WHERE e.application_id IS NOT NULL AND e.severity IN ('amber', 'red') AND q.done_at IS NOT NULL
        AND q.done_at >= q.requested_at AND e.created_at > q.done_at
      LIMIT 50
     ON CONFLICT (application_id) DO UPDATE SET requested_at = now(), reason = 'staff_event'
     RETURNING application_id`,
    [],
  );
  return docs.rows.length + banking.rows.length + submitted.rows.length + staff.rows.length;
}

/** Step 2: run up to `batch` due applications. */
export async function processQueue(db: Q, deps: EngineDeps = {}, batch = FRAUD_BATCH): Promise<number> {
  const due = await db.query(
    `SELECT application_id FROM fraud_queue
      WHERE (done_at IS NULL OR done_at < requested_at) AND next_attempt_at <= now()
      ORDER BY requested_at ASC LIMIT $1`,
    [batch],
  );
  for (const row of due.rows) {
    const id = String(row.application_id);
    const started = new Date();
    try {
      const r = await runFraudChecks(db, id, deps);
      // done_at = when this run STARTED, so anything that arrived during the run queues it again.
      await db.query(`UPDATE fraud_queue SET done_at = $2, attempts = 0, last_error = $3 WHERE application_id = $1`, [id, started, r?.errors.length ? r.errors.join("; ").slice(0, 500) : null]);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      console.error("[fraud-worker] run failed", { applicationId: id, message });
      await db.query(
        `UPDATE fraud_queue SET attempts = attempts + 1, last_error = $2,
                next_attempt_at = now() + (LEAST(attempts + 1, 6) * interval '10 minutes'),
                done_at = CASE WHEN attempts + 1 >= 6 THEN $3 ELSE done_at END
          WHERE application_id = $1`,
        [id, message.slice(0, 500), started],
      );
    }
  }
  return due.rows.length;
}

/** Step 3: share newly confirmed fraud with the watchlist and withdraw files restored out of Fraud. */
export async function syncWatchlist(db: Q, opts: { env?: NodeJS.ProcessEnv; fetchImpl?: OpsFetch } = {}): Promise<{ shared: number; withdrawn: number }> {
  const env = opts.env ?? process.env;
  const out = { shared: 0, withdrawn: 0 };
  if (!(await getFraudSettings(db)).watchlist_opt_in || !watchlistReady(env).ok) return out;
  const toShare = await db.query(
    `SELECT a.id::text AS id FROM applications a LEFT JOIN fraud_watchlist_shares s ON s.application_id = a.id::text
      WHERE a.pipeline_state = 'Fraud' AND a.fraud_confirmed_at IS NOT NULL
        AND (s.application_id IS NULL OR (s.shared_at IS NULL AND (s.last_attempt_at IS NULL OR s.last_attempt_at < now() - interval '1 hour')) OR s.withdrawn_at IS NOT NULL)
      LIMIT 20`,
    [],
  );
  for (const row of toShare.rows) {
    const p = await loadProfile(db, row.id);
    if (!p) continue;
    const entries = watchlistEntries(p, { bankAccounts: await accountNumbersFor(db, row.id) }, env);
    const ref = applicationRef(row.id, env);
    const r = entries.length ? await postToOps("watchlist/report", { application_ref: ref, entries }, { env, fetchImpl: opts.fetchImpl }) : { ok: true as const, status: 200, body: null };
    await db.query(
      `INSERT INTO fraud_watchlist_shares (application_id, application_ref, entry_count, shared_at, withdrawn_at, last_attempt_at, last_error)
       VALUES ($1, $2, $3, $4, NULL, now(), $5)
       ON CONFLICT (application_id) DO UPDATE SET application_ref = EXCLUDED.application_ref, entry_count = EXCLUDED.entry_count,
         shared_at = EXCLUDED.shared_at, withdrawn_at = NULL, last_attempt_at = now(), last_error = EXCLUDED.last_error`,
      [row.id, ref, entries.length, r.ok ? new Date() : null, r.ok ? null : r.error.slice(0, 300)],
    );
    if (r.ok) out.shared++;
    else console.warn("[fraud-worker] watchlist report failed", { applicationId: row.id, error: r.error });
  }
  const toWithdraw = await db.query(
    `SELECT s.application_id, s.application_ref FROM fraud_watchlist_shares s JOIN applications a ON a.id::text = s.application_id
      WHERE s.shared_at IS NOT NULL AND s.withdrawn_at IS NULL AND (a.pipeline_state <> 'Fraud' OR a.fraud_confirmed_at IS NULL)
      LIMIT 20`,
    [],
  );
  for (const row of toWithdraw.rows) {
    const r = await postToOps("watchlist/withdraw", { application_ref: row.application_ref }, { env, fetchImpl: opts.fetchImpl });
    if (r.ok) {
      await db.query(`UPDATE fraud_watchlist_shares SET withdrawn_at = now(), last_error = NULL WHERE application_id = $1`, [row.application_id]);
      out.withdrawn++;
    } else {
      console.warn("[fraud-worker] watchlist withdraw failed", { applicationId: row.application_id, error: r.error });
      await db.query(`UPDATE fraud_watchlist_shares SET last_attempt_at = now(), last_error = $2 WHERE application_id = $1`, [row.application_id, r.error.slice(0, 300)]);
    }
  }
  return out;
}

export async function runFraudTick(db: Q, deps: EngineDeps = {}): Promise<void> {
  await queueNewWork(db);
  await processQueue(db, deps);
  await syncWatchlist(db, { env: deps.env, fetchImpl: deps.opsFetch });
  await alertAdmins(db);
}

export function startFraudWorker(pool: Pool, deps: EngineDeps = {}): { stop: () => void } {
  let stopped = false;
  let running = false;
  const db = pool as unknown as Q;
  const tickUnclaimed = async () => {
    if (stopped || running) return;
    running = true;
    try { await runFraudTick(db, deps); }
    catch (err) { console.error("[fraud-worker] tick failed:", (err as Error)?.message ?? err); }
    finally { running = false; }
  };
  const tick = claimedTick("fraud_checks", tickUnclaimed);
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 25_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
