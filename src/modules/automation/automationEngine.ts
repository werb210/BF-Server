import { ALBERTA_TZ } from "../../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_BLOCK_v616 - automation engine (HubSpot-style workflows).
// A trigger (emitAutomationEvent) enrolls a contact/application in every enabled rule
// whose conditions match. Each enrollment keeps its own copy of the rule's steps, so
// editing a rule only affects new enrollments. runEnrollment walks the steps: actions
// run, "wait" schedules the next step, "check" stops the enrollment when it no longer
// applies. Every step is written to automation_step_log and the contact timeline.
// Never throws into the operation that fired the trigger.
import { nextAllowedSendTime, renderTokens } from "./conditions.js";
import { buildContext, emitWith, stepsOf, type AutomationEvent, type EngineDeps, type Step } from "./automationContext.js";
import { logStep, OUTWARD, runAction, runCheck, waitMs } from "./automationSteps.js";

export { buildContext, emitWith, stepsOf };
export type { AutomationEvent, EngineDeps, Step };


export async function runEnrollment(deps: EngineDeps, enrollmentId: string): Promise<string> {
  const q = deps.query;
  const claim = await q(
    `UPDATE automation_enrollments SET locked_until = now() + interval '2 minutes', updated_at = now()
      WHERE id = $1::uuid AND status = 'active' AND next_run_at <= now() AND (locked_until IS NULL OR locked_until < now())
      RETURNING id::text AS id, rule_id::text AS rule_id, silo, contact_id::text AS contact_id, application_id, context, steps, current_step, attempts, test_mode, created_at`,
    [enrollmentId]);
  const e = claim.rows[0];
  if (!e) return "not_due";
  const steps: Step[] = Array.isArray(e.steps) ? e.steps : [];
  let i = Number(e.current_step) || 0;
  const save = (sql: string, params: unknown[]) => q(sql, params);
  while (i < steps.length) {
    const step = steps[i];
    if (step.type === "wait") {
      const at = new Date(deps.now().getTime() + waitMs(step));
      await logStep(q, e, i, "wait", "waiting", `until ${at.toISOString()}`);
      await save(`UPDATE automation_enrollments SET current_step = $2, next_run_at = $3, locked_until = NULL, attempts = 0, context = $4::jsonb WHERE id = $1::uuid`, [e.id, i + 1, at.toISOString(), JSON.stringify(e.context)]);
      return "waiting";
    }
    if (step.type === "check") {
      const ok = await runCheck(q, e, step).catch((err: any) => { console.warn("[automation] check failed", { message: err?.message }); return false; });
      if (!ok) {
        await logStep(q, e, i, "check", "stopped", String(step.check));
        await save(`UPDATE automation_enrollments SET status = 'stopped', current_step = $2, locked_until = NULL, completed_at = now() WHERE id = $1::uuid`, [e.id, i]);
        return "stopped";
      }
      await logStep(q, e, i, "check", "passed", String(step.check));
      i++;
      continue;
    }
    if (OUTWARD.has(step.type) && !e.test_mode) {
      const later = nextAllowedSendTime(deps.now(), process.env.AUTOMATION_QUIET_TZ || ALBERTA_TZ);
      if (later) {
        await logStep(q, e, i, step.type, "waiting", `quiet hours - sending at ${later.toISOString()}`);
        await save(`UPDATE automation_enrollments SET current_step = $2, next_run_at = $3, locked_until = NULL WHERE id = $1::uuid`, [e.id, i, later.toISOString()]);
        return "quiet_hours";
      }
    }
    if (e.test_mode) {
      await logStep(q, e, i, step.type, "dry_run", `would run: ${renderTokens(step.title || step.body || step.type, e.context ?? {}).slice(0, 200)}`);
      i++;
      continue;
    }
    try {
      const detail = await runAction(deps, e, step);
      await logStep(q, e, i, step.type, detail.startsWith("skip:") ? "skipped" : "done", detail);
      i++;
      await save(`UPDATE automation_enrollments SET current_step = $2, attempts = 0, context = $3::jsonb WHERE id = $1::uuid`, [e.id, i, JSON.stringify(e.context)]);
    } catch (err: any) {
      const attempts = Number(e.attempts) + 1;
      const message = String(err?.message ?? err).slice(0, 300);
      await logStep(q, e, i, step.type, "failed", message);
      if (attempts >= 3) {
        await save(`UPDATE automation_enrollments SET status = 'failed', attempts = $2, last_error = $3, locked_until = NULL WHERE id = $1::uuid`, [e.id, attempts, message]);
        console.error("[automation] enrollment failed", { enrollmentId: e.id, step: step.type, message });
        return "failed";
      }
      await save(`UPDATE automation_enrollments SET attempts = $2, last_error = $3, next_run_at = now() + interval '15 minutes', locked_until = NULL WHERE id = $1::uuid`, [e.id, attempts, message]);
      return "retry";
    }
  }
  await save(`UPDATE automation_enrollments SET status = 'completed', current_step = $2, locked_until = NULL, completed_at = now() WHERE id = $1::uuid`, [e.id, i]);
  return "completed";
}

export async function runDue(deps: EngineDeps, limit = 50): Promise<number> {
  const due = await deps.query(
    `SELECT id::text AS id FROM automation_enrollments
      WHERE status = 'active' AND next_run_at <= now() AND (locked_until IS NULL OR locked_until < now())
      ORDER BY next_run_at ASC LIMIT $1`, [limit]);
  for (const r of due.rows) await runEnrollment(deps, r.id).catch((err: any) => console.error("[automation] run failed", { id: r.id, message: err?.message }));
  return due.rows.length;
}

// ---- production wiring ------------------------------------------------------
export async function defaultDeps(): Promise<EngineDeps> {
  const { pool } = await import("../../db.js");
  return {
    query: (sql, params) => pool.query(sql, params as any[]) as any,
    now: () => new Date(),
    async sendSms(to, message) {
      const { sendSms } = await import("../notifications/sms.service.js");
      await sendSms({ to, message, track: { kind: "automation" } });
    },
    async notifyClient({ silo, phone, contactId, applicationId, title, body }) {
      if (silo === "BI") {
        // BI applicants are told by BI-Server (app first, SMS fallback) - the same path staff replies use.
        if (!contactId) return "none";
        const { notifyBiApplicant } = await import("../../services/biApplicantMessages.js");
        const r = await notifyBiApplicant({ contactId, body: `${title}: ${body}`, staffName: null });
        if (!r.ok) throw new Error(`BI notice failed: ${r.error}`);
        return "app";
      }
      const { pushToClientApp } = await import("../../services/notifications/notifyClient.js");
      const viaApp = await pushToClientApp({ phone, applicationId, kind: "automation", title, body, sms: "", categoryId: "APPLICATION_UPDATE" } as any);
      if (viaApp) return "app";
      const { sendSms } = await import("../notifications/sms.service.js");
      const base = String(process.env.CLIENT_URL ?? "https://client.boreal.financial").replace(/\/$/, "");
      await sendSms({ to: phone, message: `Boreal: ${body}\n${applicationId ? `${base}/application/${encodeURIComponent(applicationId)}` : `${base}/portal`}`, track: { kind: "automation", applicationId } });
      return "sms";
    },
  };
}

/** Called from trigger points. Enrolls, then runs whatever is due at once (e.g. a task with no wait). */
export async function emitAutomationEvent(ev: AutomationEvent): Promise<void> {
  try {
    const deps = await defaultDeps();
    const ids = await emitWith(deps, ev);
    for (const id of ids) await runEnrollment(deps, id).catch((err: any) => console.error("[automation] immediate run failed", { id, message: err?.message }));
  } catch (err: any) {
    console.error("[automation] emit failed", { trigger: ev.trigger, message: err?.message ?? String(err) });
  }
}

/** Kept for the existing stage-change call site (BF_SERVER_AUTOMATION_ENGINE_v1). */
export const runAutomations = emitAutomationEvent;
