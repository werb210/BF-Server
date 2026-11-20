// BF_SERVER_TEAMS_ATTENDEE_REMINDERS_v1 (2026-11-20) - people invited to a Boreal Teams meeting said the invite
// carried no reminder. A Microsoft invite's reminder belongs to each attendee's own calendar (Gmail and others
// often set none), so Boreal now emails every attendee itself 24 hours and 1 hour before, with the Join link.
// Attendees are read from the organiser's calendar at send time, so edits and cancellations are respected.
// Each meeting is claimed before it is sent, so nobody gets two.
import { ALBERTA_TZ } from "../../lib/albertaTime.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type GraphLike = { fetch: (path: string, init?: RequestInit) => Promise<Response> };
export type ReminderDeps = {
  graphFor: (userId: string) => Promise<GraphLike | null>;
  email: (to: string, subject: string, html: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  now?: () => Date;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function whenText(startsAt: Date): string {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: ALBERTA_TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(startsAt);
  return `${d} Mountain Time`;
}

export function reminderMessage(m: { subject: string; startsAt: Date; joinUrl: string; organizerName: string | null }, which: "24h" | "1h") {
  const lead = which === "24h" ? "tomorrow" : "in about an hour";
  const subject = `Reminder: ${m.subject} ${lead}`;
  const when = whenText(m.startsAt);
  const who = m.organizerName ? ` with ${m.organizerName}` : "";
  const text = `This is a reminder of your Microsoft Teams meeting${who}: ${m.subject}\n${when}\n\nJoin: ${m.joinUrl}\n\nThe dial-in number is in the original invite.`;
  const html = `<p>This is a reminder of your Microsoft Teams meeting${esc(who)}:</p><p><strong>${esc(m.subject)}</strong><br>${esc(when)}</p>`
    + `<p><a href="${esc(m.joinUrl)}" style="display:inline-block;background:#5b5fc7;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Join the meeting</a></p>`
    + `<p style="color:#555;font-size:13px">The dial-in number is in the original invite.</p>`;
  return { subject, html, text };
}

export async function sendDueMeetingReminders(db: Q, deps: ReminderDeps): Promise<{ sent: number; skipped: number; errors: number }> {
  const now = deps.now?.() ?? new Date();
  const out = { sent: 0, skipped: 0, errors: 0 };
  for (const which of ["24h", "1h"] as const) {
    const col = which === "24h" ? "reminder_24h_at" : "reminder_1h_at";
    const within = which === "24h" ? "24 hours" : "1 hour";
    const lead = which === "24h" ? "25 hours" : "75 minutes"; // booked at short notice: the invite itself is the reminder
    const claimed = await db.query(
      `UPDATE teams_meetings SET ${col} = $1
        WHERE status = 'scheduled' AND ${col} IS NULL AND graph_event_id IS NOT NULL AND organizer_user_id IS NOT NULL
          AND join_url IS NOT NULL AND scheduled_at > $1 AND scheduled_at <= $1::timestamptz + interval '${within}'
          AND created_at <= scheduled_at - interval '${lead}'
        RETURNING id::text AS id, organizer_user_id::text AS organizer_user_id, organizer_upn, subject, graph_event_id, join_url, scheduled_at`,
      [now.toISOString()]);
    for (const row of claimed.rows) {
      try {
        const graph = await deps.graphFor(String(row.organizer_user_id));
        if (!graph) { out.skipped += 1; console.warn("[teams-reminders] organiser calendar not connected", { meetingId: row.id, which }); continue; }
        const r = await graph.fetch(`/me/events/${encodeURIComponent(String(row.graph_event_id))}?$select=subject,start,isCancelled,attendees,organizer`);
        if (!r.ok) { out.skipped += 1; console.warn("[teams-reminders] event not readable", { meetingId: row.id, which, status: r.status }); continue; }
        const ev: any = await r.json();
        if (ev?.isCancelled) { out.skipped += 1; continue; }
        const organizer = String(ev?.organizer?.emailAddress?.address ?? row.organizer_upn ?? "").toLowerCase();
        const organizerName = ev?.organizer?.emailAddress?.name ? String(ev.organizer.emailAddress.name) : null;
        const startsAt = ev?.start?.dateTime ? new Date(String(ev.start.dateTime) + (String(ev.start.timeZone ?? "UTC").toUpperCase() === "UTC" && !/Z$/.test(ev.start.dateTime) ? "Z" : "")) : new Date(row.scheduled_at);
        const people = (Array.isArray(ev?.attendees) ? ev.attendees : [])
          .filter((a: any) => a?.type !== "resource" && a?.status?.response !== "declined")
          .map((a: any) => String(a?.emailAddress?.address ?? "").trim())
          .filter((e: string) => e.includes("@") && e.toLowerCase() !== organizer);
        const msg = reminderMessage({ subject: String(ev?.subject || row.subject || "Teams meeting"), startsAt: isNaN(startsAt.getTime()) ? new Date(row.scheduled_at) : startsAt, joinUrl: String(row.join_url), organizerName }, which);
        for (const to of Array.from(new Set<string>(people))) {
          const s = await deps.email(to, msg.subject, msg.html, msg.text);
          if (s.ok) out.sent += 1; else { out.errors += 1; console.warn("[teams-reminders] email failed", { meetingId: row.id, which, error: s.error }); }
        }
      } catch (err) {
        out.errors += 1;
        console.warn("[teams-reminders] meeting failed", { meetingId: row.id, which, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

export function defaultMeetingReminderDeps(pool: any): ReminderDeps {
  return {
    async graphFor(userId) {
      const { getGraphForUser } = await import("../../modules/o365/graphClient.js");
      return getGraphForUser(pool, userId).catch((err: unknown) => { console.warn("[teams-reminders] organiser sign-in failed", { message: err instanceof Error ? err.message : String(err) }); return null; });
    },
    async email(to, subject, html, text) {
      const { sendClientMail } = await import("../../settingsPack/boreal.js");
      return sendClientMail({ to: [to], subject, html, text });
    },
  };
}
