import { ALBERTA_TZ } from "../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_MEETING_NOTIFY_v741
import { DIAL_IN_DISPLAY, inviteText, joinUrl, oneTapDial, type MeetingRoom } from "./meetingRooms.js";
import { isAppGraphConfigured } from "./teams/graphAppClient.js";

export type MeetingDelivery = { calendar: "created" | "updated" | "cancelled" | "skipped" | "failed"; calendarError: string | null; emailed: number; texted: number; errors: string[] };
type Row = { id: string; name: string; email: string | null; phone: string | null; invited_at: string | null; texted_at: string | null };
type Host = { name: string; email: string | null; phone: string | null };
export type MeetingNotifyDeps = {
  graphReady: () => boolean;
  graph: (path: string, method: string, body?: unknown) => Promise<{ ok: boolean; status: number; json: any; text: string }>;
  sms: (to: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  email: (to: string, subject: string, html: string) => Promise<{ ok: boolean; error?: string }>;
  query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
};
const NL = String.fromCharCode(10);
const digits = (p: string | null) => String(p ?? "").replace(/[^0-9]/g, "");
const e164 = (p: string | null): string | null => { const d = digits(p); if (d.length === 10) return "+1" + d; if (d.length === 11 && d.startsWith("1")) return "+" + d; return null; };
const whenOf = (room: MeetingRoom) => new Date(room.starts_at).toLocaleString("en-CA", { timeZone: ALBERTA_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const utc = (d: Date) => d.toISOString().slice(0, 19);

export function meetingSms(room: MeetingRoom): string {
  return "Boreal Financial meeting: " + room.title + ", " + whenOf(room) + " Alberta time. To join, call " + DIAL_IN_DISPLAY + ", press 3, enter code " + room.code + " then #. One tap: " + oneTapDial(room.code) + " Details: " + joinUrl(room.slug);
}
async function hostOf(room: MeetingRoom, deps: MeetingNotifyDeps): Promise<Host | null> {
  if (!room.host_user_id) return null;
  const r = await deps.query("SELECT trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, email, COALESCE(NULLIF(phone_number,''), NULLIF(phone,'')) AS phone FROM users WHERE id::text = $1 LIMIT 1", [room.host_user_id]);
  const h = r.rows[0];
  return h ? { name: String(h.name || "Boreal staff"), email: h.email ?? null, phone: h.phone ?? null } : null;
}
async function peopleOf(room: MeetingRoom, deps: MeetingNotifyDeps): Promise<Row[]> {
  const r = await deps.query("SELECT id::text AS id, name, email, phone, invited_at, texted_at FROM meeting_participants WHERE room_id::text = $1 ORDER BY created_at", [room.id]);
  return r.rows as Row[];
}
function eventBody(room: MeetingRoom, attendees: Row[]) {
  const start = new Date(room.starts_at); const end = new Date(start.getTime() + room.duration_min * 60_000);
  return { subject: room.title, body: { contentType: "Text", content: inviteText(room) + NL + NL + "One tap from a mobile: " + oneTapDial(room.code) }, start: { dateTime: utc(start), timeZone: "UTC" }, end: { dateTime: utc(end), timeZone: "UTC" }, location: { displayName: "Phone " + DIAL_IN_DISPLAY + ", press 3, code " + room.code }, attendees: attendees.map((p) => ({ emailAddress: { address: p.email, name: p.name }, type: "required" })), allowNewTimeProposals: false, reminderMinutesBeforeStart: 15 };
}
export async function notifyMeeting(room: MeetingRoom, opts: { isNew: boolean }, deps: MeetingNotifyDeps = defaultDeps): Promise<MeetingDelivery> {
  const out: MeetingDelivery = { calendar: "skipped", calendarError: null, emailed: 0, texted: 0, errors: [] };
  let calendarInFlight = false; // BF_SERVER_NO_DUPLICATE_ROOMS_v764
  const host = await hostOf(room, deps); const people = await peopleOf(room, deps);
  const hostEmail = (host?.email ?? "").toLowerCase();
  const attendees = people.filter((p) => p.email && p.email.toLowerCase() !== hostEmail);
  if (!host?.email) out.calendarError = "the meeting host has no email on their staff profile";
  else if (!deps.graphReady()) out.calendarError = "Outlook (Microsoft Graph) is not configured on the server";
  else {
    const existing = (await deps.query("SELECT graph_event_id, host_email FROM meeting_rooms WHERE id::text = $1", [room.id])).rows[0];
    // BF_SERVER_NO_DUPLICATE_ROOMS_v764 - only ONE request may create a room's Outlook event. Two requests for the same
    // room (e.g. people added while the room is still being created) both saw no event id and both POSTed, so Outlook
    // showed the meeting twice. A request now claims the room with a "pending:<time>" marker first; a request that
    // can't claim it leaves the calendar to the one that did. A claim older than 2 minutes (a crashed request) expires.
    const raw = existing?.graph_event_id ? String(existing.graph_event_id) : "";
    const eventId = raw && !raw.startsWith("pending:") ? raw : null;
    let claimed = Boolean(eventId);
    if (!eventId) {
      const c = await deps.query("UPDATE meeting_rooms SET graph_event_id = $2 WHERE id::text = $1 AND (graph_event_id IS NULL OR (CASE WHEN graph_event_id LIKE 'pending:%' THEN substring(graph_event_id from 9)::timestamptz END) < now() - interval '2 minutes') RETURNING id::text", [room.id, "pending:" + new Date().toISOString()]);
      claimed = c.rows.length > 0;
    }
    if (!claimed) { calendarInFlight = true; out.calendar = "skipped"; }
    const path = "/users/" + encodeURIComponent(existing?.host_email || host.email) + "/events";
    const r = !claimed ? { ok: false, status: 0, json: null, text: "" } : eventId ? await deps.graph(path + "/" + encodeURIComponent(eventId), "PATCH", eventBody(room, attendees)) : await deps.graph(path, "POST", eventBody(room, attendees));
    if (!claimed) { /* another request is creating this room's Outlook event */ }
    else if (r.ok) {
      out.calendar = eventId ? "updated" : "created";
      if (!eventId) await deps.query("UPDATE meeting_rooms SET graph_event_id = $2, host_email = $3 WHERE id::text = $1", [room.id, String(r.json?.id ?? ""), host.email]);
      const fresh = attendees.filter((p) => !p.invited_at);
      if (fresh.length) await deps.query("UPDATE meeting_participants SET invited_at = now() WHERE id::text = ANY($1::text[])", [fresh.map((p) => p.id)]);
      out.emailed = fresh.length;
    } else {
      out.calendar = "failed"; out.calendarError = "Outlook refused the event (" + r.status + "): " + r.text.slice(0, 160);
      if (!eventId) await deps.query("UPDATE meeting_rooms SET graph_event_id = NULL WHERE id::text = $1 AND graph_event_id LIKE 'pending:%'", [room.id]);
    }
  }
  if (out.calendarError) out.errors.push("calendar: " + out.calendarError);
  if ((out.calendar === "skipped" || out.calendar === "failed") && !calendarInFlight) {
    const html = inviteText(room).split(NL).map((l) => "<p style='margin:0 0 6px;font-family:Arial,sans-serif;color:#0B1F3A'>" + l.replace(/[<>&]/g, " ") + "</p>").join("") + "<p style='font-family:Arial,sans-serif'><a href='" + joinUrl(room.slug) + "/ics'>Add to calendar</a></p>";
    const targets: Array<{ id: string | null; email: string }> = attendees.filter((p) => !p.invited_at).map((p) => ({ id: p.id, email: p.email as string }));
    if (opts.isNew && host?.email) targets.push({ id: null, email: host.email });
    for (const t of targets) { const r = await deps.email(t.email, "Invitation: " + room.title, html); if (r.ok) { out.emailed += 1; if (t.id) await deps.query("UPDATE meeting_participants SET invited_at = now() WHERE id::text = $1", [t.id]); } else out.errors.push("email to " + t.email + ": " + String(r.error ?? "failed")); }
  }
  const text = meetingSms(room); const texts: Array<{ id: string | null; phone: string; who: string }> = [];
  for (const p of people) { const n = e164(p.phone); if (n && !p.texted_at) texts.push({ id: p.id, phone: n, who: p.name }); }
  const hostPhone = e164(host?.phone ?? null);
  if (opts.isNew && hostPhone && !texts.some((t) => t.phone === hostPhone)) texts.push({ id: null, phone: hostPhone, who: host?.name ?? "host" });
  if (opts.isNew && !hostPhone) out.errors.push("text to you: no mobile number on your staff profile");
  for (const t of texts) { const r = await deps.sms(t.phone, text); if (r.ok) { out.texted += 1; if (t.id) await deps.query("UPDATE meeting_participants SET texted_at = now() WHERE id::text = $1", [t.id]); } else out.errors.push("text to " + t.who + ": " + String(r.error ?? "failed")); }
  return out;
}
export async function cancelMeetingNotices(room: MeetingRoom, deps: MeetingNotifyDeps = defaultDeps): Promise<MeetingDelivery> {
  const out: MeetingDelivery = { calendar: "skipped", calendarError: null, emailed: 0, texted: 0, errors: [] };
  const ev = (await deps.query("SELECT graph_event_id, host_email FROM meeting_rooms WHERE id::text = $1", [room.id])).rows[0];
  if (ev?.graph_event_id && !String(ev.graph_event_id).startsWith("pending:") && ev?.host_email && deps.graphReady()) { const r = await deps.graph("/users/" + encodeURIComponent(ev.host_email) + "/events/" + encodeURIComponent(ev.graph_event_id) + "/cancel", "POST", { comment: "This meeting was cancelled." }); if (r.ok) out.calendar = "cancelled"; else { out.calendar = "failed"; out.calendarError = "Outlook refused the cancellation (" + r.status + ")"; out.errors.push("calendar: " + out.calendarError); } }
  const people = await peopleOf(room, deps);
  for (const p of people) { const n = e164(p.phone); if (!n || !p.texted_at) continue; const r = await deps.sms(n, "Boreal Financial: the meeting " + room.title + " on " + whenOf(room) + " Alberta time has been cancelled."); if (r.ok) out.texted += 1; else out.errors.push("text to " + p.name + ": " + String(r.error ?? "failed")); }
  return out;
}
const defaultDeps: MeetingNotifyDeps = {
  graphReady: () => isAppGraphConfigured(),
  async graph(path, method, body) { try { const { graphAppFetch } = await import("./teams/graphAppClient.js"); const resp = await graphAppFetch(path, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); let text = ""; try { text = await resp.text(); } catch { text = ""; } let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; } return { ok: resp.ok, status: resp.status, json, text }; } catch (err: any) { return { ok: false, status: 0, json: null, text: String(err?.message ?? err) }; } },
  async sms(to, text) { try { const { sendSms } = await import("../modules/notifications/sms.service.js"); const r: any = await sendSms({ to, message: text, track: { kind: "meeting_invite" } } as any); return r && r.sid ? { ok: true } : { ok: false, error: "not sent (server TEST_MODE or no Twilio message id)" }; } catch (err: any) { return { ok: false, error: String(err?.message ?? err) }; } },
  async email(to, subject, html) { const { sendgridConfigured, sendTransactional } = await import("./sendgridService.js"); if (!sendgridConfigured()) return { ok: false, error: "email (SendGrid) is not configured on the server" }; return sendTransactional({ to, subject, html, customArgs: { kind: "meeting_invite" } }); },
  async query(sql, params) { const { pool } = await import("../db.js"); return pool.query(sql, params as any[]); },
};
