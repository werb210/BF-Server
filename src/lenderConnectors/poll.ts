// BF_SERVER_v873_LENDER_API - pulling a deal's status from the lender (the worker every few minutes, "Sync now" on the
// Lenders tab, and right after a webhook), and the worker's submit retries.
import type { Pool } from "pg";
import type { Q } from "../settingsPack/common.js";
import { connectorFor } from "./registry.js";
import { lenderHttp } from "./http.js";
import { loadConnectionById, openSecrets } from "./store.js";
import { applyRemoteUpdate, logEvent, type ApplyResult, type EventSource, type SubmissionRow } from "./sync.js";
import type { RemoteUpdate } from "./types.js";
import type { StatusMapEntry } from "./mapping.js";

type SubRow = SubmissionRow & { connection_id: string | null; lender_name: string };

const SUB_COLS = `s.id::text AS id, s.application_id, s.lender_id::text AS lender_id, s.connector, s.external_id, s.lender_status, s.bucket,
  s.connection_id::text AS connection_id, l.name AS lender_name`;

export type SyncOutcome = { ok: true; result: ApplyResult } | { ok: false; error: string };

/** Applies one update (from a poll or a webhook) to a submission, with the connection's maps. */
export async function applyToSubmission(db: Q, sub: SubRow, update: RemoteUpdate, source: EventSource): Promise<SyncOutcome> {
  const connection = sub.connection_id ? await loadConnectionById(db, sub.connection_id) : null;
  const connector = connectorFor(connection?.connector ?? sub.connector);
  if (!connection || !connector) return { ok: false, error: "This lender's connection was removed." };
  const result = await applyRemoteUpdate(db, {
    submission: sub, lenderName: sub.lender_name, update, source,
    adminStatusMap: (connection.status_map ?? {}) as Record<string, StatusMapEntry>,
    connectorDefaults: connector.defaultStatusMap(connection.config ?? {}),
    pollIntervalMinutes: connection.poll_interval_minutes ?? 30,
  });
  await db.query(`UPDATE lender_connections SET last_sync_at = now(), last_error = NULL WHERE id::text = $1`, [connection.id]);
  return { ok: true, result };
}

export async function loadSubmission(db: Q, applicationId: string, lenderId: string): Promise<SubRow | null> {
  const r = await db.query(
    `SELECT ${SUB_COLS} FROM lender_api_submissions s JOIN lenders l ON l.id = s.lender_id
      WHERE s.application_id = $1 AND s.lender_id::text = $2 LIMIT 1`, [applicationId, lenderId],
  );
  return (r.rows[0] as SubRow | undefined) ?? null;
}

/** Reads the deal from the lender now. */
export async function syncSubmission(db: Q, sub: SubRow, source: EventSource): Promise<SyncOutcome> {
  if (!sub.external_id) return { ok: false, error: "The lender did not give this deal an id, so its status cannot be read back." };
  const connection = sub.connection_id ? await loadConnectionById(db, sub.connection_id) : null;
  const connector = connectorFor(connection?.connector ?? sub.connector);
  if (!connection || !connector) return { ok: false, error: "This lender's connection was removed." };
  if (connector.availability !== "available") return { ok: false, error: "This lender's API is not available yet." };
  if (!connector.capabilities.status || !connector.fetchStatus) return { ok: false, error: "This lender's API does not report status back." };
  let fetched;
  try {
    fetched = await connector.fetchStatus({ config: connection.config ?? {}, secrets: openSecrets(connection.secrets_encrypted), http: lenderHttp() }, sub.external_id);
  } catch (err) {
    fetched = { ok: false as const, error: err instanceof Error ? err.message : String(err), retryable: true };
  }
  if (!fetched.ok) {
    await db.query(
      `UPDATE lender_api_submissions SET next_poll_at = now() + ($2 || ' minutes')::interval, updated_at = now() WHERE id::text = $1`,
      [sub.id, String(Math.max(5, connection.poll_interval_minutes ?? 30) * (fetched.retryable ? 1 : 4))],
    );
    await db.query(`UPDATE lender_connections SET last_error = $2 WHERE id::text = $1`, [connection.id, fetched.error.slice(0, 500)]);
    await logEvent(db, { submissionId: sub.id, applicationId: sub.application_id, lenderId: sub.lender_id, kind: "sync_failed", source, detail: fetched.error });
    return { ok: false, error: fetched.error };
  }
  return applyToSubmission(db, sub, fetched.update, source);
}

/** Submissions due a poll (connection on, polling on, the lender can report status, not finished). */
export async function pollDue(db: Q, limit = 20): Promise<number> {
  // A funded deal is polled for its balance only while the file's Active Contract is open: once every contract on the
  // file is paid out, refinanced, matured or closed, polling stops.
  await db.query(
    `UPDATE lender_api_submissions s SET next_poll_at = NULL
      WHERE s.bucket = 'funded' AND s.next_poll_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM active_contracts ac WHERE ac.application_id = s.application_id)
        AND NOT EXISTS (SELECT 1 FROM active_contracts ac WHERE ac.application_id = s.application_id
                         AND ac.status NOT IN ('refinanced','paid_out','matured','closed'))`, []);
  const r = await db.query(
    `SELECT ${SUB_COLS} FROM lender_api_submissions s
       JOIN lenders l ON l.id = s.lender_id
       JOIN lender_connections c ON c.id = s.connection_id
      WHERE s.next_poll_at IS NOT NULL AND s.next_poll_at <= now() AND s.external_id IS NOT NULL
        AND c.enabled = true AND c.poll_enabled = true
      ORDER BY s.next_poll_at
      LIMIT $1`, [limit],
  );
  let n = 0;
  for (const row of r.rows as SubRow[]) {
    const connector = connectorFor(row.connector);
    if (!connector?.capabilities.status) {
      await db.query(`UPDATE lender_api_submissions SET next_poll_at = NULL WHERE id::text = $1`, [row.id]);
      continue;
    }
    await syncSubmission(db, row, "poll");
    n += 1;
  }
  return n;
}

/** Submissions whose API send failed with a retryable error and are due another try. */
export async function retryDue(pool: Pool, limit = 5): Promise<number> {
  const r = await pool.query<{ application_id: string; lender_id: string }>(
    `SELECT s.application_id, s.lender_id::text AS lender_id FROM lender_api_submissions s
      WHERE s.status = 'retrying' AND s.next_retry_at IS NOT NULL AND s.next_retry_at <= now()
      ORDER BY s.next_retry_at LIMIT $1`, [limit],
  );
  const { submitByApiToLender } = await import("./submit.js");
  for (const row of r.rows) {
    // Clear the due time first so a failing retry is never picked up twice in one tick.
    await pool.query(`UPDATE lender_api_submissions SET next_retry_at = NULL WHERE application_id = $1 AND lender_id::text = $2`, [row.application_id, row.lender_id]);
    const out = await submitByApiToLender(pool, row.application_id, row.lender_id, null);
    if (!out.ok && out.reason !== "api_submit_failed") {
      // Not a lender failure (lock held, application changed): try again shortly without counting an attempt.
      await pool.query(
        `UPDATE lender_api_submissions SET next_retry_at = now() + interval '5 minutes' WHERE application_id = $1 AND lender_id::text = $2 AND status = 'retrying'`,
        [row.application_id, row.lender_id],
      );
    }
  }
  return r.rows.length;
}

/** The submission a pushed update is about: our deal id or the record that now carries its status. */
export async function findSubmissionForPush(db: Q, lenderId: string, externalId: string): Promise<SubRow | null> {
  const r = await db.query(
    `SELECT ${SUB_COLS} FROM lender_api_submissions s JOIN lenders l ON l.id = s.lender_id
      WHERE s.lender_id::text = $1 AND (s.external_id = $2 OR s.linked_record_id = $2) LIMIT 1`, [lenderId, externalId],
  );
  return (r.rows[0] as SubRow | undefined) ?? null;
}
