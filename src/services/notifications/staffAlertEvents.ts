// BF_SERVER_v820_WATCH_CALLS - the five staff alert events (missed call, voicemail, client-portal message, inbound
// SMS, Maya handoff) all go through notifyAllStaff, so each one reaches the same staff as the portal bell, the
// browser push, the Watch and the iPhone dialler. Every helper is best-effort and never throws: the webhook or
// request that triggered it must not fail because an alert could not be delivered.
import { pool } from "../../db.js";
import { notifyAllStaff } from "./notifyAllStaff.js";
import { STAFF_ALERT_BODY_MAX } from "./staffAlerts.js";

type Silo = string | null | undefined;

function e164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

function preview(text: unknown, max = STAFF_ALERT_BODY_MAX): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function contactLabel(from: string | null): Promise<{ label: string; contactId: string | null }> {
  if (!from) return { label: "Unknown caller", contactId: null };
  try {
    if (/^client:/i.test(from)) {
      const { resolveClientIdentityCaller } = await import("../../modules/voice/voicemailEnrich.service.js");
      const r = await resolveClientIdentityCaller(from);
      return { label: r?.label || "Boreal app caller", contactId: r?.contactId ?? null };
    }
    const { contactForPhone } = await import("../../voice/watchCellFallback.js");
    const c = await contactForPhone(pool, from);
    // An unrecognised voicemail caller gets a contact literally named "Unknown caller"; the number says more.
    const name = c?.name && c.name.trim().toLowerCase() !== "unknown caller" ? c.name : "";
    return { label: name || from, contactId: c?.id ?? null };
  } catch (err) {
    console.warn("[staff_alert] caller label failed", String((err as Error)?.message ?? err).slice(0, 200));
    return { label: from, contactId: null };
  }
}

async function run(event: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) {
    console.warn(JSON.stringify({ event: "staff_alert_failed", alert: event, error: String((err as Error)?.message ?? err).slice(0, 200) }));
  }
}

/** An inbound call nobody answered. staffUserId set = the call was for that person (direct line / named target). */
export async function alertMissedCall(input: { from: string | null | undefined; staffUserId?: string | null; silo?: Silo; callSid?: string | null }): Promise<void> {
  await run("missed_call", async () => {
    const from = String(input.from ?? "").trim() || null;
    const { label, contactId } = await contactLabel(from);
    const phone = e164(from);
    await notifyAllStaff({
      pool, silo: input.silo ?? "BF", skipSms: true,
      ...(input.staffUserId ? { userIds: [input.staffUserId] } : {}),
      notificationType: "call_missed", title: "Missed call", body: `Missed call from ${label}`,
      refTable: input.callSid ? "calls" : undefined, refId: input.callSid ?? undefined,
      contextUrl: contactId ? `/crm/contacts/${contactId}` : "/communications",
      watch: { category: "MISSED_CALL", eventType: "missed_call", title: "Missed call", body: label },
      staffAlert: { category: "MISSED_CALL", type: "missed_call", title: "Missed call", body: label, data: { contactId, phone } },
    });
  });
}

export async function alertVoicemail(input: {
  from: string | null | undefined; callerLabel?: string | null; contactId?: string | null; staffUserId?: string | null;
  transcript?: string | null; silo?: Silo; recordingSid?: string | null;
}): Promise<void> {
  await run("voicemail", async () => {
    const from = String(input.from ?? "").trim() || null;
    const label = input.callerLabel || (await contactLabel(from)).label;
    const text = input.transcript ? preview(input.transcript) : "New voicemail";
    await notifyAllStaff({
      pool, silo: input.silo ?? "BF", skipSms: true, // the voicemail SMS is already sent by voicemailEnrich
      ...(input.staffUserId ? { userIds: [input.staffUserId] } : {}),
      notificationType: "voicemail", title: `Voicemail from ${label}`, body: text,
      refTable: input.recordingSid ? "voicemails" : undefined, refId: input.recordingSid ?? undefined,
      contextUrl: input.contactId ? `/crm/contacts/${input.contactId}` : "/communications",
      watch: { category: "MISSED_CALL", eventType: "voicemail", title: "Voicemail", body: label },
      staffAlert: { category: "VOICEMAIL", type: "voicemail", title: `Voicemail from ${label}`, body: text, data: { contactId: input.contactId ?? null, phone: e164(from) } },
    });
  });
}

export async function alertClientMessage(input: {
  messageId: string; applicationId: string; contactId?: string | null; body?: string | null; attachmentCount?: number; silo?: Silo;
}): Promise<void> {
  await run("client_message", async () => {
    let name = "";
    let contactId = input.contactId ?? null;
    let silo: string = input.silo ?? "BF";
    try {
      const r = await pool.query<{ contact_id: string | null; name: string | null; silo: string | null }>(
        `SELECT c.id::text AS contact_id, a.silo,
                NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS name
           FROM applications a LEFT JOIN contacts c ON c.id = COALESCE($2::uuid, a.contact_id)
          WHERE a.id::text = $1 LIMIT 1`,
        [input.applicationId, contactId],
      );
      name = r.rows[0]?.name ?? "";
      contactId = contactId ?? r.rows[0]?.contact_id ?? null;
      if (!input.silo && r.rows[0]?.silo) silo = String(r.rows[0].silo);
    } catch (err) {
      console.warn("[staff_alert] client message contact lookup failed", String((err as Error)?.message ?? err).slice(0, 200));
    }
    const who = name || "a client";
    const text = input.body && input.body.trim() ? preview(input.body) : (input.attachmentCount ? "Sent an attachment" : "New message");
    await notifyAllStaff({
      pool, silo, skipSms: true, // the "available staff" SMS is sent by the route
      notificationType: "client_message", title: `Message from ${who}`, body: text,
      refTable: "communications_messages", refId: input.messageId,
      contextUrl: contactId ? `/communications?contact=${contactId}` : "/communications",
      watch: { category: "MESSAGE", eventType: "client_message", title: `Message from ${who}`, body: text },
      staffAlert: { category: "CLIENT_MESSAGE", type: "client_message", title: `Message from ${who}`, body: text,
        data: { contactId, applicationId: input.applicationId, threadKind: "messages" } },
    });
  });
}

export async function alertMayaHandoff(input: { escalationId: string; contactId?: string | null; summary?: string | null; silo?: Silo; phone?: string | null }): Promise<void> {
  await run("maya_handoff", async () => {
    const text = input.summary && input.summary.trim() ? preview(input.summary) : "A visitor asked to talk to a person";
    await notifyAllStaff({
      pool, silo: input.silo ?? "BF", skipSms: true, // the route already sends its SMS fan-out
      notificationType: "maya_handoff", title: "Talk to a person", body: text,
      refTable: "maya_escalations", refId: input.escalationId,
      contextUrl: input.contactId ? `/crm/contacts/${input.contactId}` : "/communications",
      watch: { category: "MESSAGE", eventType: "client_message", title: "Talk to a person", body: text },
      staffAlert: { category: "HANDOFF", type: "maya_handoff", title: "Talk to a person", body: text,
        data: { contactId: input.contactId ?? null, phone: e164(input.phone), threadKind: input.contactId ? "messages" : null } },
    });
  });
}
