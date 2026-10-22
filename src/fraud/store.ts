// BF_SERVER_v846_FRAUD - storage for check results, the fraud queue and the fraud settings.
// Boreal has no plans: every one of the 15 checks is on. The two Admin settings live in the settings table
// (keys fraud.watchlist_opt_in and fraud.include_prescreen_in_package, values "true" / "false").
import type { Q } from "./types.js";
import { FRAUD_CHECKS } from "./catalogue.js";
import type { CheckResult, FraudStatus, Reason } from "./types.js";

export type ResultRow = {
  application_id: string; check_key: string; subject: string; status: FraudStatus; reasons: Reason[];
  details: Record<string, unknown>; provider: string | null; checked_at: string;
};

export async function upsertResult(db: Q, applicationId: string, checkKey: string, subject: string, r: CheckResult): Promise<void> {
  await db.query(
    `INSERT INTO fraud_check_results (application_id, check_key, subject, status, reasons, details, provider, checked_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now())
     ON CONFLICT (application_id, check_key, subject) DO UPDATE SET
       status = EXCLUDED.status, reasons = EXCLUDED.reasons, details = EXCLUDED.details,
       provider = EXCLUDED.provider, checked_at = now()`,
    [applicationId, checkKey, subject, r.status, JSON.stringify(r.reasons ?? []), JSON.stringify(r.details ?? {}), r.provider ?? null],
  );
}

export async function listResults(db: Q, applicationId: string): Promise<ResultRow[]> {
  const r = await db.query(
    `SELECT application_id, check_key, subject, status, reasons, details, provider, checked_at
       FROM fraud_check_results WHERE application_id = $1 ORDER BY check_key, subject`,
    [applicationId],
  );
  return r.rows.map((x: any) => ({
    ...x,
    reasons: Array.isArray(x.reasons) ? x.reasons : [],
    details: x.details && typeof x.details === "object" ? x.details : {},
    checked_at: x.checked_at instanceof Date ? x.checked_at.toISOString() : String(x.checked_at),
  }));
}

export async function previousResult(db: Q, applicationId: string, checkKey: string, subject = ""): Promise<ResultRow | null> {
  const r = await db.query(
    `SELECT application_id, check_key, subject, status, reasons, details, provider, checked_at
       FROM fraud_check_results WHERE application_id = $1 AND check_key = $2 AND subject = $3 LIMIT 1`,
    [applicationId, checkKey, subject],
  );
  return (r.rows[0] as ResultRow | undefined) ?? null;
}

/** Ask the worker to (re)run the checks for an application. Idempotent: only moves requested_at forward. */
export async function enqueueFraudRun(db: Q, applicationId: string, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO fraud_queue (application_id, requested_at, reason, next_attempt_at) VALUES ($1, now(), $2, now())
     ON CONFLICT (application_id) DO UPDATE SET requested_at = now(), reason = EXCLUDED.reason,
       next_attempt_at = LEAST(fraud_queue.next_attempt_at, now()), attempts = 0, last_error = NULL`,
    [applicationId, reason.slice(0, 80)],
  );
}

export async function queueStatus(db: Q, applicationId: string): Promise<{ queued: boolean; done_at: string | null; last_error: string | null }> {
  const r = await db.query(`SELECT requested_at, done_at, last_error FROM fraud_queue WHERE application_id = $1`, [applicationId]);
  const row = r.rows[0];
  if (!row) return { queued: false, done_at: null, last_error: null };
  const done = row.done_at ? new Date(row.done_at) : null;
  return { queued: !done || done.getTime() < new Date(row.requested_at).getTime(), done_at: done ? done.toISOString() : null, last_error: row.last_error ?? null };
}

export type FraudSettings = { watchlist_opt_in: boolean; include_prescreen_in_package: boolean; updated_at: string | null };

export const SETTING_KEYS = {
  watchlist_opt_in: "fraud.watchlist_opt_in",
  include_prescreen_in_package: "fraud.include_prescreen_in_package",
  updated_by: "fraud.updated_by",
} as const;

export async function getFraudSettings(db: Q): Promise<FraudSettings> {
  const r = await db.query(`SELECT key, value, updated_at FROM settings WHERE key = ANY($1::text[])`, [Object.values(SETTING_KEYS)]);
  const row = (k: string) => r.rows.find((x: any) => x.key === k);
  const times = r.rows.map((x: any) => (x.updated_at ? new Date(x.updated_at).getTime() : 0)).filter((t: number) => t > 0);
  return {
    watchlist_opt_in: String(row(SETTING_KEYS.watchlist_opt_in)?.value ?? "") === "true",
    include_prescreen_in_package: String(row(SETTING_KEYS.include_prescreen_in_package)?.value ?? "") === "true",
    updated_at: times.length ? new Date(Math.max(...times)).toISOString() : null,
  };
}

export async function saveFraudSettings(db: Q, patch: Partial<Pick<FraudSettings, "watchlist_opt_in" | "include_prescreen_in_package">>, userId: string): Promise<FraudSettings> {
  const rows: Array<[string, string]> = [];
  if (typeof patch.watchlist_opt_in === "boolean") rows.push([SETTING_KEYS.watchlist_opt_in, String(patch.watchlist_opt_in)]);
  if (typeof patch.include_prescreen_in_package === "boolean") rows.push([SETTING_KEYS.include_prescreen_in_package, String(patch.include_prescreen_in_package)]);
  if (rows.length) rows.push([SETTING_KEYS.updated_by, userId || "unknown"]);
  for (const [key, value] of rows) {
    await db.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }
  return getFraudSettings(db);
}

/** Every fraud check. Boreal has no plans, so all 15 always run (kept as a set so the engine and score read the same). */
export function allowedChecks(): Set<string> {
  return new Set(FRAUD_CHECKS.map((c) => c.key));
}
