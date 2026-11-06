// BF_SERVER_v906_CREDIT_STEPS - what each Credit Summary button last did on a file, so the tab shows "not run",
// "running", "done" or "failed" beside it (table credit_summary_steps, migration 2026_11_21_v906_application_file.sql).
import { pool } from "../../db.js";

export const CREDIT_STEPS = ["financials", "collateral", "research", "generate"] as const;
export type CreditStep = (typeof CREDIT_STEPS)[number];
export type StepStatus = "not_run" | "running" | "done" | "failed";
export type StepState = { step: CreditStep; status: StepStatus; message: string | null; started_at: string | null; finished_at: string | null };

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

// A run that never reported back (the server restarted mid-run) is not "running" forever.
const STALE_RUNNING_MS = 10 * 60 * 1000;

export async function markStep(step: CreditStep, applicationId: string, status: Exclude<StepStatus, "not_run">, message: string | null, actor: string | null, db: Q = pool): Promise<void> {
  try {
    await db.query(
      `INSERT INTO credit_summary_steps (application_id, step, status, message, started_at, finished_at, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'running' THEN now() END, CASE WHEN $3 <> 'running' THEN now() END, $5, now())
       ON CONFLICT (application_id, step) DO UPDATE SET status = EXCLUDED.status, message = EXCLUDED.message,
         started_at = CASE WHEN EXCLUDED.status = 'running' THEN now() ELSE credit_summary_steps.started_at END,
         finished_at = CASE WHEN EXCLUDED.status = 'running' THEN NULL ELSE now() END,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [applicationId, step, status, message ? message.slice(0, 1000) : null, actor],
    );
  } catch (err) {
    // The step itself still runs; only its status line is missing.
    console.warn("[credit-steps] mark_failed", { applicationId, step, status, message: (err as Error)?.message });
  }
}

export function stepView(rows: Array<{ step: string; status: string; message: string | null; started_at: Date | string | null; finished_at: Date | string | null }>, now = Date.now()): StepState[] {
  const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
  return CREDIT_STEPS.map((step) => {
    const r = rows.find((x) => x.step === step);
    if (!r) return { step, status: "not_run" as const, message: null, started_at: null, finished_at: null };
    let status = (["running", "done", "failed"].includes(r.status) ? r.status : "not_run") as StepStatus;
    let message = r.message ?? null;
    if (status === "running" && r.started_at && now - new Date(r.started_at).getTime() > STALE_RUNNING_MS) {
      status = "failed";
      message = "This run did not finish (the server may have restarted). Run it again.";
    }
    return { step, status, message, started_at: iso(r.started_at), finished_at: iso(r.finished_at) };
  });
}

export async function listSteps(applicationId: string, db: Q = pool): Promise<StepState[]> {
  const r = await db.query(
    `SELECT step, status, message, started_at, finished_at FROM credit_summary_steps WHERE application_id = $1`,
    [applicationId],
  ).catch((err: unknown) => {
    console.warn("[credit-steps] list_failed", { applicationId, message: (err as Error)?.message });
    return { rows: [] as any[] };
  });
  return stepView(r.rows);
}

/** Runs one step with its status recorded around it. */
export async function runStep<T>(step: CreditStep, applicationId: string, actor: string | null, fn: () => Promise<T>, summarize: (r: T) => string | null): Promise<T> {
  await markStep(step, applicationId, "running", null, actor);
  try {
    const result = await fn();
    await markStep(step, applicationId, "done", summarize(result), actor);
    return result;
  } catch (err) {
    await markStep(step, applicationId, "failed", (err as Error)?.message ?? "failed", actor);
    throw err;
  }
}
