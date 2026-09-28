// BF_SERVER_NOTIFY_CONTACT_v626
// Staff "Notify" button: one notice to a contact, app first, SMS if the app
// can't be reached. Boreal Risk (BI) contacts are told through BI-Server, which
// does its own app-first / SMS fallback. Every notice lands on the timeline.
import { pool } from "../../db.js";
import { logError } from "../../observability/logger.js";

export type NotifyChannel = "app" | "sms" | "bi" | "none";
export type NotifyContactInput = { contactId: string; title: string; body: string; actorUserId?: string | null; staffName?: string | null };
export type NotifyContactResult = { ok: boolean; channel: NotifyChannel; error?: string };

export function cleanNotice(title: unknown, body: unknown): { title: string; body: string } | null {
  const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Update on your application";
  const b = String(body ?? "").trim().slice(0, 500);
  return b ? { title: t, body: b } : null;
}

export async function notifyContact(input: NotifyContactInput): Promise<NotifyContactResult> {
  const { rows } = await pool.query<{ id: string; phone: string | null; silo: string | null }>(
    "SELECT id::text AS id, phone, silo FROM contacts WHERE id::text = $1 LIMIT 1",
    [input.contactId],
  );
  const contact = rows[0];
  if (!contact) return { ok: false, channel: "none", error: "contact_not_found" };
  const silo = String(contact.silo ?? "BF").toUpperCase();
  let result: NotifyContactResult;

  if (silo === "BI") {
    const { notifyBiApplicant } = await import("../biApplicantMessages.js");
    const r = await notifyBiApplicant({ contactId: contact.id, body: input.title + ": " + input.body, staffName: input.staffName ?? null });
    result = r.ok ? { ok: true, channel: "bi" } : { ok: false, channel: "none", error: r.error };
  } else if (!contact.phone) {
    result = { ok: false, channel: "none", error: "no_phone" };
  } else {
    const app = await pool.query<{ id: string }>(
      "SELECT id::text AS id FROM applications WHERE contact_id::text = $1 ORDER BY created_at DESC LIMIT 1",
      [contact.id],
    ).catch((err: any) => { logError("notify_contact_application_lookup_failed", { contactId: contact.id, message: err?.message }); return { rows: [] as Array<{ id: string }> }; });
    const applicationId = app.rows[0]?.id ?? null;
    const { pushToClientApp } = await import("./notifyClient.js");
    const viaApp = await pushToClientApp({
      phone: contact.phone, applicationId, kind: "staff_notice", title: input.title, body: input.body,
      sms: "", categoryId: "APPLICATION_UPDATE",
    } as any).catch(() => false);
    if (viaApp) {
      result = { ok: true, channel: "app" };
    } else {
      try {
        const { sendSms } = await import("../../modules/notifications/sms.service.js");
        const base = String(process.env.CLIENT_URL ?? "https://client.boreal.financial").replace(/\/$/, "");
        const link = applicationId ? base + "/application/" + encodeURIComponent(applicationId) : base + "/portal";
        await sendSms({ to: contact.phone, message: "Boreal: " + input.body + "\n" + link, track: { kind: "staff_notice", applicationId } } as any);
        result = { ok: true, channel: "sms" };
      } catch (err: any) {
        result = { ok: false, channel: "none", error: String(err?.message ?? err) };
      }
    }
  }

  await pool.query(
    "INSERT INTO crm_timeline_events (contact_id, event_type, payload, actor_user_id) VALUES ($1::uuid, 'client_notice_sent', $2::jsonb, $3::uuid)",
    [contact.id, JSON.stringify({ title: input.title, body: input.body, channel: result.channel, ok: result.ok, error: result.error ?? null }), input.actorUserId ?? null],
  ).catch((err: any) => { logError("notify_contact_timeline_failed", { contactId: contact.id, message: err?.message }); });
  return result;
}
