// BF_SERVER_v887_MAYA_LEAD_TASK - when Maya (the website chat) captures a lead, the owner gets a call-back task.
//
// Owner: lead rotation first (Settings > Lead rotation, "website" source, only for a contact with no owner yet),
// then the contact's owner, then the first active Admin (the same fallback the automation engine uses).
// The task is a CALL, due today on the Alberta clock (5 pm, or the end of the day when it is already later), titled
// "Call back <name>: website chat lead", linked to the contact. No task is added when the contact already has an open
// follow-up task created in the last 24 hours, so a visitor who chats twice does not make two.
import type { Q } from "../settingsPack/common.js";
import { zonedParts, zonedTime } from "../settingsPack/boreal.js";
import { assignRotatingOwner, rotationSilo } from "./leadRotation.js";
import { FALLBACK_USER_SQL } from "../modules/automation/automationContext.js";

/** The sources the agent sends when Maya captures a website lead (lead.capture and visitor.identify). */
export const MAYA_LEAD_SOURCES = ["maya_visitor_tool", "maya_visitor_intake"] as const;

export function isMayaWebsiteLead(source: unknown): boolean {
  return (MAYA_LEAD_SOURCES as readonly string[]).includes(String(source ?? "").trim().toLowerCase());
}

/** Due today on the Alberta clock: 5 pm, or 11:59 pm when it is already 5 pm or later. */
export function dueTodayAlberta(now: Date = new Date()): Date {
  const p = zonedParts(now);
  const fivePm = zonedTime(p.y, p.m, p.d, 17, 0);
  return now.getTime() < fivePm.getTime() ? fivePm : zonedTime(p.y, p.m, p.d, 23, 59);
}

export function callBackTitle(name: string | null | undefined): string {
  const who = String(name ?? "").trim() || "the website visitor";
  return `Call back ${who}: website chat lead`.slice(0, 200);
}

export type MayaLeadTaskResult =
  | { created: true; taskId: string; assigneeUserId: string }
  | { created: false; reason: "open_task_exists" | "no_assignee" | "no_contact" };

export async function createMayaLeadFollowUp(
  db: Q,
  input: { contactId: string | null | undefined; silo: string; name: string | null; isNewContact: boolean; message?: string | null },
  now: Date = new Date(),
): Promise<MayaLeadTaskResult> {
  const contactId = input.contactId ? String(input.contactId) : "";
  if (!contactId) return { created: false, reason: "no_contact" };
  const silo = rotationSilo(input.silo);

  const open = await db.query(
    `SELECT id FROM tasks
      WHERE contact_id::text = $1
        AND deleted_at IS NULL
        AND status NOT IN ('COMPLETED','DEFERRED')
        AND created_at > now() - interval '24 hours'
      LIMIT 1`,
    [contactId],
  );
  if (open.rows.length) return { created: false, reason: "open_task_exists" };

  // Lead rotation only gives an owner to a contact that has none; it logs and returns null on any failure.
  const rotated = input.isNewContact ? await assignRotatingOwner(db, contactId, "website", { silo }) : null;
  const owner = await db.query(
    `SELECT COALESCE($2::uuid, (SELECT owner_id FROM contacts WHERE id::text = $1), ${FALLBACK_USER_SQL}) AS user_id`,
    [contactId, rotated],
  );
  const assignee = owner.rows[0]?.user_id ? String(owner.rows[0].user_id) : null;
  if (!assignee) return { created: false, reason: "no_assignee" };

  const body = ["A visitor left their details in the website chat (Maya). Call them back today."]
    .concat(input.message ? [`What they said: ${String(input.message).slice(0, 500)}`] : [])
    .join("\n");
  const ins = await db.query(
    `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source)
     VALUES ($1, $2, $3, 'CALL', 'HIGH', $4, $5::uuid, $6::uuid, 'API')
     RETURNING id::text AS id`,
    [silo, callBackTitle(input.name), body, dueTodayAlberta(now).toISOString(), assignee, contactId],
  );
  return { created: true, taskId: String(ins.rows[0]?.id ?? ""), assigneeUserId: assignee };
}
