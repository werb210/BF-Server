// BF_SERVER_AUTOMATION_ENGINE_v1 - "when X happens, do Y". Best-effort: never
// throws into the triggering operation. Conditions are plain equality against the
// event context (no dynamic SQL). Actions currently: create_task, add_note, send_push.
import { pool } from "../../db.js";
// BF_SERVER_BLOCK_v334_CLIENT_PUSH_DELIVERY_v1
import { sendClientPush } from "../../services/clientPushService.js";

export type AutomationEvent = {
  trigger: string;
  silo?: string;
  applicationId?: string;
  contactId?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
};

function conditionsMatch(cond: unknown, event: AutomationEvent): boolean {
  if (!cond || typeof cond !== "object") return true;
  for (const key of Object.keys(cond as Record<string, unknown>)) {
    if ((event as Record<string, unknown>)[key] !== (cond as Record<string, unknown>)[key]) return false;
  }
  return true;
}

async function runAction(action: Record<string, unknown>, ctx: { silo: string; contactId: string | null; applicationId?: string }): Promise<void> {
  const type = String(action?.type ?? "");
  if (type === "create_task") {
    const days = String(Number(action.dueDays ?? 1) || 1);
    const title = String(action.title ?? "Follow up");
    await pool.query(
      `INSERT INTO tasks (silo, title, body, type, priority, due_at, contact_id, source, source_ref_id)
       SELECT $1, $2, $3, 'TODO', 'MEDIUM', now() + ($4 || ' days')::interval, $5::uuid, 'AUTOMATION', $6::uuid
        WHERE NOT EXISTS (
          SELECT 1 FROM tasks WHERE source = 'AUTOMATION' AND source_ref_id = $6::uuid AND title = $2
        )`,
      [ctx.silo, title, action.body ?? null, days, ctx.contactId, ctx.applicationId ?? null],
    );
  } else if (type === "send_push" && ctx.applicationId) {
    // Resolve the applicant behind the application, then notify their devices.
    const owner = await pool.query<{ user_id: string | null }>(
      `SELECT user_id FROM applications WHERE id = $1`, [ctx.applicationId],
    ).catch(() => ({ rows: [] as { user_id: string | null }[] }));
    const userId = owner.rows[0]?.user_id;
    if (userId) {
      await sendClientPush({
        userId,
        title: String(action.title ?? "Application update"),
        body: String(action.body ?? ""),
        silo: ctx.silo as "BF" | "BI" | "SLF",
        data: { applicationId: ctx.applicationId },
      });
    }
  } else if (type === "add_note" && ctx.contactId) {
    await pool.query(`INSERT INTO crm_notes (body, contact_id, silo) VALUES ($1, $2::uuid, $3)`, [String(action.body ?? ""), ctx.contactId, ctx.silo]);
  }
}

export async function runAutomations(event: AutomationEvent): Promise<void> {
  try {
    let silo = event.silo;
    let contactId = event.contactId ?? null;
    if ((!silo || !contactId) && event.applicationId) {
      const r = await pool.query<{ silo: string | null; contact_id: string | null }>(`SELECT silo, contact_id FROM applications WHERE id = $1`, [event.applicationId])
        .catch(() => ({ rows: [] as { silo: string | null; contact_id: string | null }[] }));
      silo = silo || r.rows[0]?.silo || "BF";
      contactId = contactId || r.rows[0]?.contact_id || null;
    }
    silo = silo || "BF";
    const { rows } = await pool.query<{ conditions: unknown; actions: unknown }>(
      `SELECT conditions, actions FROM automation_rules WHERE enabled = true AND silo = $1 AND trigger_type = $2`, [silo, event.trigger]);
    for (const rule of rows) {
      if (!conditionsMatch(rule.conditions, event)) continue;
      const actions = Array.isArray(rule.actions) ? (rule.actions as Record<string, unknown>[]) : [];
      for (const action of actions) await runAction(action, { silo, contactId, applicationId: event.applicationId }).catch(() => {});
    }
  } catch { /* best-effort */ }
}
