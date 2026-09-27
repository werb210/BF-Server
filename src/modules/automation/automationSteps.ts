// BF_SERVER_BLOCK_v616 - automation steps: logging, waits, checks and actions.
import { renderTokens } from "./conditions.js";
import { FALLBACK_USER_SQL, SYSTEM_USER, type EngineDeps, type Query, type Step } from "./automationContext.js";

export async function logStep(q: Query, e: any, i: number, type: string, outcome: string, detail: string | null) {
  await q(`INSERT INTO automation_step_log (enrollment_id, rule_id, step_index, step_type, outcome, detail) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [e.id, e.rule_id, i, type, outcome, detail ? detail.slice(0, 500) : null]);
  if (e.contact_id && outcome === "done") {
    await q(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1::uuid, 'automation', $2::jsonb)`,
      [e.contact_id, JSON.stringify({ rule_id: e.rule_id, step: type, detail })]).catch((err: any) =>
      console.warn("[automation] timeline write failed", { message: err?.message }));
  }
}

export function waitMs(step: Step): number {
  const n = Math.max(0, Number(step.amount ?? 0));
  const unit = String(step.unit ?? "hours");
  return n * (unit === "minutes" ? 60_000 : unit === "days" ? 86_400_000 : 3_600_000);
}

export async function runCheck(q: Query, e: any, step: Step): Promise<boolean> {
  const ctx = e.context ?? {};
  if (step.check === "still_in_stage") {
    if (!e.application_id || !ctx.to_stage) return false;
    const r = await q(`SELECT pipeline_state FROM applications WHERE id::text = $1`, [e.application_id]);
    return r.rows[0]?.pipeline_state === ctx.to_stage;
  }
  if (step.check === "documents_still_rejected") {
    if (ctx.document_id) {
      const r = await q(`SELECT status FROM documents WHERE id::text = $1`, [ctx.document_id]);
      return r.rows[0]?.status === "rejected";
    }
    if (!e.application_id) return false;
    const r = await q(`SELECT 1 FROM documents WHERE application_id::text = $1 AND status = 'rejected' LIMIT 1`, [e.application_id]);
    return r.rows.length > 0;
  }
  if (step.check === "no_reply_since_start") {
    if (!e.contact_id) return true;
    const r = await q(`SELECT 1 FROM communications_messages WHERE contact_id::text = $1 AND direction = 'inbound' AND created_at > $2 LIMIT 1`, [e.contact_id, e.created_at]);
    return r.rows.length === 0;
  }
  return false;
}

/** Runs one action. Returns a short description of what happened, or throws. "skip:" prefix = not done, not an error. */
export async function runAction(deps: EngineDeps, e: any, step: Step): Promise<string> {
  const q = deps.query;
  const ctx = e.context ?? {};
  const t = (s: unknown) => renderTokens(s, ctx);
  switch (step.type) {
    case "create_task": {
      const assignee = step.assignTo === "user" && step.userId ? step.userId : null;
      const hours = Math.max(0, Number(step.dueHours ?? 24));
      const type = ["CALL", "EMAIL", "SMS", "TODO"].includes(String(step.taskType)) ? String(step.taskType) : "TODO";
      const priority = ["NONE", "LOW", "MEDIUM", "HIGH"].includes(String(step.priority)) ? String(step.priority) : "MEDIUM";
      const r = await q(
        `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source, source_ref_id)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval,
                 COALESCE($7::uuid, (SELECT owner_user_id FROM applications WHERE id::text = $8), (SELECT owner_id FROM contacts WHERE id::text = $9), ${FALLBACK_USER_SQL}),
                 $9::uuid, 'WORKFLOW', $10::uuid)
         RETURNING id::text AS id`,
        [e.silo, t(step.title || "Follow up").slice(0, 200), t(step.body || "") || null, type, priority, String(hours), assignee, e.application_id, e.contact_id, e.id]);
      return `task ${r.rows[0]?.id ?? ""}`;
    }
    case "send_sms": {
      if (!e.contact_id) return "skip: no contact";
      const purpose = step.purpose === "transactional" ? "transactional" : "marketing";
      const { SMS_ELIGIBLE_SQL } = await import("../../services/smsConsent.js");
      const gate = purpose === "marketing"
        ? SMS_ELIGIBLE_SQL
        : `COALESCE(c.phone,'') <> '' AND COALESCE(c.sms_opt_out, false) = false`;
      const r = await q(`SELECT c.phone FROM contacts c WHERE c.id::text = $1 AND ${gate} LIMIT 1`, [e.contact_id]);
      if (!r.rows[0]?.phone) return `skip: no ${purpose === "marketing" ? "consent or opt-in" : "phone or opted out"}`;
      await deps.sendSms(r.rows[0].phone, t(step.body));
      return `sms sent (${purpose})`;
    }
    case "notify_client": {
      const phone = ctx.phone as string | undefined;
      if (!phone) return "skip: no phone";
      const via = await deps.notifyClient({ silo: e.silo, phone, contactId: e.contact_id, applicationId: e.application_id, title: t(step.title || "Update from Boreal"), body: t(step.body) });
      return via === "none" ? "skip: client could not be reached" : `client notified by ${via}`;
    }
    case "notify_staff": {
      const r = await q(
        `INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url)
         VALUES (COALESCE($1::uuid, (SELECT owner_user_id FROM applications WHERE id::text = $2), (SELECT owner_id FROM contacts WHERE id::text = $3), ${FALLBACK_USER_SQL}),
                 'automation', 'automation_enrollments', $4, $5, $6) RETURNING id`,
        [step.userId || null, e.application_id, e.contact_id, e.id, t(step.body || "Automation update").slice(0, 500), e.application_id ? `/applications/${e.application_id}` : e.contact_id ? `/crm/contacts/${e.contact_id}` : "/automations"]);
      return r.rows.length ? "staff notified" : "skip: nobody to notify";
    }
    case "assign_owner": {
      if (!e.contact_id && !e.application_id) return "skip: nothing to assign";
      let userId: string | null = step.mode === "user" ? step.userId ?? null : null;
      if (step.mode !== "user") {
        const pool = Array.isArray(step.userIds) && step.userIds.length
          ? step.userIds
          : (await q(`SELECT id::text AS id FROM users WHERE active = true AND role IN ('Admin','Staff') AND id::text <> '${SYSTEM_USER}' AND (silo IS NULL OR silo = $1) ORDER BY created_at ASC`, [e.silo])).rows.map((r: any) => r.id);
        if (!pool.length) return "skip: no active staff";
        const n = await q(`UPDATE automation_rules SET rr_index = rr_index + 1 WHERE id = $1::uuid RETURNING rr_index`, [e.rule_id]);
        userId = pool[(Number(n.rows[0]?.rr_index ?? 1) - 1) % pool.length];
      }
      if (!userId) return "skip: no user";
      if (e.contact_id) await q(`UPDATE contacts SET owner_id = $2::uuid, updated_at = now() WHERE id::text = $1`, [e.contact_id, userId]);
      if (e.application_id) await q(`UPDATE applications SET owner_user_id = $2::uuid WHERE id::text = $1`, [e.application_id, userId]);
      const u = await q(`SELECT first_name, last_name FROM users WHERE id = $1::uuid`, [userId]);
      const name = [u.rows[0]?.first_name, u.rows[0]?.last_name].filter(Boolean).join(" ");
      e.context = { ...ctx, owner_name: name || ctx.owner_name, contact_owner_id: userId };
      return `owner ${userId}`;
    }
    case "add_tag": {
      if (!e.contact_id || !step.tag) return "skip: no contact or tag";
      await q(`UPDATE contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags,'{}') || ARRAY[$2::text]))), updated_at = now() WHERE id::text = $1`, [e.contact_id, String(step.tag).slice(0, 60)]);
      return `tag ${step.tag}`;
    }
    case "add_note": {
      if (!e.contact_id) return "skip: no contact";
      await q(`INSERT INTO crm_notes (body, contact_id, silo) VALUES ($1, $2::uuid, $3)`, [t(step.body), e.contact_id, e.silo]);
      return "note added";
    }
    default:
      return `skip: unknown step ${step.type}`;
  }
}

export const OUTWARD = new Set(["send_sms", "notify_client"]);

/** Claims one enrollment and runs it until it waits, stops, fails or completes. */
