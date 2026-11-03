// BF_SERVER_v869_BOOKING_PAGES (ported from KS-server #38 BF_SERVER_v869_SETTINGS_PACK_BOOKING) - public booking pages: one per staff member (client app /book/<name>) and the team page
// (/book/team, round robin through services/clientBooking.ts). Meeting types, booking hours, the confirmation email,
// reminders 24 hours and 1 hour before (email always; a text only when the client ticked it and the contact has
// texting consent), and the client's own cancel / reschedule link. Every booking creates or matches a contact and
// lands on its timeline (crm_meetings + crm_timeline_events).
import { brandName, supportPhone } from "../settingsPack/boreal.js";
import { clientUrl } from "../settingsPack/boreal.js";
import { brokerageTimeZone, zoneLabel } from "../settingsPack/boreal.js";
import {
  DEFAULT_BOOKING_HOURS, DEFAULT_MEETING_TYPE, bookableStaff, mailboxOf, type BookingHours, type MeetingType, type Staff,
} from "../services/clientBooking.js";
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export const TEAM_SLUG = "team";

/** The link name for a staff member's own page: their first name (else the start of their email), lower case. */
export const slugOf = (firstName: string | null, email: string) => String(firstName || email.split(/[.@]/)[0] || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// BF_SERVER_v885_BOOKING_ORIGINAL - the one booking page is the website's /book-<name> (e.g. www.boreal.financial/book-todd).
export function websiteBookingUrl(staffFirstName: string | null): string {
  const site = (process.env.BF_WEBSITE_URL ?? process.env.WEBSITE_URL ?? "https://www.boreal.financial").replace(/\/+$/, "");
  const slug = String(staffFirstName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return slug ? `${site}/book-${slug}` : `${site}/contact`;
}
export function staffPageUrl(slug: string): string {
  return `${clientUrl().replace(/\/+$/, "")}/book/${encodeURIComponent(slug)}`;
}
export function manageUrl(token: string): string {
  return `${clientUrl().replace(/\/+$/, "")}/book/manage/${encodeURIComponent(token)}`;
}

// ------------------------------------------------------------------ brokerage booking settings
export type BookingSettings = {
  team_page: boolean;
  hours: BookingHours;
  reminders: { email_24h: boolean; email_1h: boolean; sms_24h: boolean; sms_1h: boolean };
  confirmation_note: string;
};
export const DEFAULT_BOOKING_SETTINGS: BookingSettings = {
  team_page: true,
  hours: DEFAULT_BOOKING_HOURS,
  reminders: { email_24h: true, email_1h: true, sms_24h: true, sms_1h: true },
  confirmation_note: "",
};
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function normalizeBookingSettings(raw: unknown): BookingSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const hours: BookingHours = {};
  for (let d = 0; d < 7; d += 1) {
    const src = r.hours?.[d] ?? r.hours?.[String(d)];
    hours[d] = Array.isArray(src)
      ? src.filter((x: unknown) => Array.isArray(x) && HHMM.test(String(x[0])) && HHMM.test(String(x[1])) && String(x[0]) < String(x[1])).slice(0, 3).map((x: any) => [String(x[0]), String(x[1])] as [string, string])
      : [...(DEFAULT_BOOKING_HOURS[d] ?? [])];
  }
  const rem = (r.reminders && typeof r.reminders === "object" ? r.reminders : {}) as Record<string, unknown>;
  const flag = (k: keyof BookingSettings["reminders"]) => (typeof rem[k] === "boolean" ? (rem[k] as boolean) : DEFAULT_BOOKING_SETTINGS.reminders[k]);
  return {
    team_page: typeof r.team_page === "boolean" ? r.team_page : true,
    hours,
    reminders: { email_24h: flag("email_24h"), email_1h: flag("email_1h"), sms_24h: flag("sms_24h"), sms_1h: flag("sms_1h") },
    confirmation_note: String(r.confirmation_note ?? "").trim().slice(0, 500),
  };
}

// BF_SERVER_v885_BOOKING_ORIGINAL - the Booking pages settings are retired (they duplicated Todd's website booking page):
// bookings run on the original hours and the original 30-minute call, whatever an old saved setting says. The client's
// own cancel / reschedule link and the reminders stay.
export async function bookingSettings(_db: Q): Promise<BookingSettings> {
  return { ...DEFAULT_BOOKING_SETTINGS, team_page: false };
}
export async function saveBookingSettings(db: Q, raw: unknown, actor: string | null): Promise<BookingSettings> {
  const value = normalizeBookingSettings(raw);
  await writeSetting(db, "booking", value, actor);
  return value;
}

// ------------------------------------------------------------------ meeting types
const TYPE_COLS = `id::text AS id, slug, name, description, duration_min, kind, buffer_min, min_notice_min, max_days_ahead, active, sort`;
export type MeetingTypeRow = MeetingType & { active: boolean; sort: number };

export async function listMeetingTypes(db: Q, opts: { activeOnly?: boolean } = {}): Promise<MeetingTypeRow[]> {
  const r = await db.query(`SELECT ${TYPE_COLS} FROM booking_meeting_types ${opts.activeOnly ? "WHERE active" : ""} ORDER BY sort, name LIMIT 50`);
  return r.rows.map((x) => ({ ...x, duration_min: Number(x.duration_min), buffer_min: Number(x.buffer_min), min_notice_min: Number(x.min_notice_min), max_days_ahead: Number(x.max_days_ahead) })) as MeetingTypeRow[];
}

/** The meeting types a page offers: the Admin's active ones, or the original 30-minute phone call when none exist. */
export async function offeredTypes(_db: Q): Promise<MeetingType[]> {
  return [DEFAULT_MEETING_TYPE]; // BF_SERVER_v885_BOOKING_ORIGINAL - meeting types retired with Booking pages
}

export async function findOfferedType(db: Q, idOrSlug: unknown): Promise<MeetingType | null> {
  const want = String(idOrSlug ?? "").trim();
  const types = await offeredTypes(db);
  if (!want) return types[0] ?? null;
  return types.find((t) => t.id === want || t.slug === want) ?? null;
}

export type TypeInput = { name: string; slug: string; description: string | null; duration_min: number; kind: "phone" | "video"; buffer_min: number; min_notice_min: number; max_days_ahead: number; active: boolean; sort: number };

export function validateMeetingType(raw: unknown): { ok: true; value: TypeInput } | { ok: false; errors: Record<string, string> } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const errors: Record<string, string> = {};
  const name = String(r.name ?? "").trim();
  if (!name || name.length > 80) errors.name = "Give the meeting a name (80 characters at most).";
  const slug = String(r.slug ?? name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!slug) errors.slug = "Give the meeting a short link name.";
  const int = (k: string, min: number, max: number, dflt: number, label: string) => {
    const v = r[k] === undefined || r[k] === "" ? dflt : Math.round(Number(r[k]));
    if (!Number.isFinite(v) || v < min || v > max) errors[k] = `${label} must be between ${min} and ${max}.`;
    return Number.isFinite(v) ? v : dflt;
  };
  const value: TypeInput = {
    name, slug, description: String(r.description ?? "").trim().slice(0, 500) || null,
    duration_min: int("duration_min", 10, 240, 30, "Length (minutes)"),
    kind: r.kind === "video" ? "video" : "phone",
    buffer_min: int("buffer_min", 0, 120, 0, "Buffer (minutes)"),
    min_notice_min: int("min_notice_min", 0, 20160, 120, "Minimum notice (minutes)"),
    max_days_ahead: int("max_days_ahead", 1, 90, 14, "Days ahead"),
    active: r.active !== false,
    sort: int("sort", 0, 1000, 0, "Order"),
  };
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}

export async function createMeetingType(db: Q, v: TypeInput): Promise<MeetingTypeRow | null> {
  const r = await db.query(
    `INSERT INTO booking_meeting_types (slug, name, description, duration_min, kind, buffer_min, min_notice_min, max_days_ahead, active, sort)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (slug) DO NOTHING RETURNING ${TYPE_COLS}`,
    [v.slug, v.name, v.description, v.duration_min, v.kind, v.buffer_min, v.min_notice_min, v.max_days_ahead, v.active, v.sort]);
  return (r.rows[0] as MeetingTypeRow) ?? null;
}

export async function updateMeetingType(db: Q, id: string, v: TypeInput): Promise<MeetingTypeRow | null> {
  const r = await db.query(
    `UPDATE booking_meeting_types SET slug = $2, name = $3, description = $4, duration_min = $5, kind = $6, buffer_min = $7,
            min_notice_min = $8, max_days_ahead = $9, active = $10, sort = $11, updated_at = now()
      WHERE id::text = $1 RETURNING ${TYPE_COLS}`,
    [id, v.slug, v.name, v.description, v.duration_min, v.kind, v.buffer_min, v.min_notice_min, v.max_days_ahead, v.active, v.sort]);
  return (r.rows[0] as MeetingTypeRow) ?? null;
}

export async function deleteMeetingType(db: Q, id: string): Promise<boolean> {
  const r = await db.query(`DELETE FROM booking_meeting_types WHERE id::text = $1 RETURNING id`, [id]);
  return r.rows.length > 0;
}

// ------------------------------------------------------------------ pages and links
export async function staffForSlug(slug: string): Promise<Staff | null> {
  const want = String(slug ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!want || want === TEAM_SLUG) return null;
  return (await bookableStaff()).find((x) => slugOf(x.first_name, x.email) === want) ?? null;
}

/** Every bookable person's link, and the team link (for Settings and the staff profile). */
export async function bookingLinks(): Promise<{ team: string; staff: Array<{ user_id: string; name: string; slug: string; url: string }> }> {
  const staff = await bookableStaff();
  return {
    team: staffPageUrl(TEAM_SLUG),
    staff: staff.map((s) => ({ user_id: s.id, name: s.first_name || s.email, slug: slugOf(s.first_name, s.email), url: staffPageUrl(slugOf(s.first_name, s.email)) })),
  };
}

// ------------------------------------------------------------------ messages
export function whenText(startsAt: Date | string, tz: string = brokerageTimeZone()): string {
  return new Date(startsAt).toLocaleString("en-CA", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) + ` (${zoneLabel()})`;
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

export type BookingMessageInput = {
  clientName: string; startsAt: string; durationMin: number; kind: "phone" | "teams"; staffFirstName: string | null;
  meetingName: string; joinUrl: string | null; phone: string | null; manageToken: string | null; note?: string;
};

function howText(b: BookingMessageInput): string {
  if (b.kind === "phone") return `${b.staffFirstName || "We"} will call you${b.phone ? ` at ${b.phone}` : ""}.`;
  return b.joinUrl ? `Join the video meeting: ${b.joinUrl}` : "The video meeting link is in your calendar invitation.";
}

export function confirmationEmail(b: BookingMessageInput): { subject: string; text: string; html: string } {
  const lines = [
    `Hi ${b.clientName},`, "",
    `Your ${b.meetingName.toLowerCase()} with ${b.staffFirstName || brandName()} is booked for ${whenText(b.startsAt)} (${b.durationMin} minutes).`,
    howText(b), b.note ? `\n${b.note}` : "",
    b.manageToken ? `\nNeed to change it? Cancel or pick a new time here: ${manageUrl(b.manageToken)}` : "",
    "", `${brandName()}${supportPhone() ? ` - ${supportPhone()}` : ""}`,
  ].filter((l) => l !== undefined);
  const text = lines.join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111827;line-height:1.5">${text.split("\n").map((l) => (l ? `<p style="margin:0 0 8px">${esc(l).replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#1d4ed8">$1</a>')}</p>` : "")).join("")}</div>`;
  return { subject: `Booked: ${b.meetingName} on ${whenText(b.startsAt)}`, text, html };
}

export function reminderEmail(b: BookingMessageInput, which: "24h" | "1h"): { subject: string; text: string; html: string } {
  const lead = which === "24h" ? "tomorrow" : "in about an hour";
  const text = [`Hi ${b.clientName},`, "", `A reminder: your ${b.meetingName.toLowerCase()} with ${b.staffFirstName || brandName()} is ${lead}, ${whenText(b.startsAt)}.`, howText(b),
    b.manageToken ? `\nCan't make it? Cancel or reschedule: ${manageUrl(b.manageToken)}` : "", "", brandName()].join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111827;line-height:1.5">${text.split("\n").map((l) => (l ? `<p style="margin:0 0 8px">${esc(l).replace(/(https?:\/\/\S+)/g, '<a href="$1" style="color:#1d4ed8">$1</a>')}</p>` : "")).join("")}</div>`;
  return { subject: `Reminder: ${b.meetingName} ${which === "24h" ? "tomorrow" : "today"}`, text, html };
}

export function reminderSms(b: BookingMessageInput, which: "24h" | "1h"): string {
  const lead = which === "24h" ? "tomorrow" : "in about an hour";
  return `${brandName()}: reminder of your ${b.meetingName.toLowerCase()} ${lead}, ${whenText(b.startsAt)}.${b.manageToken ? ` Change it: ${manageUrl(b.manageToken)}` : ""} Reply STOP to opt out.`;
}

export function cancelledEmail(b: BookingMessageInput): { subject: string; text: string; html: string } {
  const text = [`Hi ${b.clientName},`, "", `Your ${b.meetingName.toLowerCase()} on ${whenText(b.startsAt)} is cancelled.`, `You can book a new time at ${websiteBookingUrl(b.staffFirstName)}.`, "", brandName()].join("\n");
  return { subject: `Cancelled: ${b.meetingName} on ${whenText(b.startsAt)}`, text, html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111827">${text.split("\n").map((l) => (l ? `<p style="margin:0 0 8px">${esc(l)}</p>` : "")).join("")}</div>` };
}

// ------------------------------------------------------------------ timeline
export async function logBookingTimeline(db: Q, contactId: string | null, type: string, payload: Record<string, unknown>): Promise<void> {
  if (!contactId) return;
  try {
    await db.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1::uuid, $2, $3::jsonb)`, [contactId, type, JSON.stringify(payload)]);
  } catch (err) {
    console.warn("[booking] timeline write failed", { contactId, type, message: err instanceof Error ? err.message : String(err) });
  }
}

// ------------------------------------------------------------------ manage (cancel / reschedule)
export type ManagedBooking = {
  id: string; contact_id: string | null; staff_user_id: string | null; staff_email: string; kind: "phone" | "teams"; starts_at: string; duration_min: number;
  client_name: string; client_email: string | null; client_phone: string | null; status: string; join_url: string | null;
  graph_event_id: string | null; crm_meeting_id: string | null; meeting_type_id: string | null;
  sms_reminders: boolean; staff_first_name: string | null; meeting_name: string | null;
};

export async function bookingByToken(db: Q, tokenHash: string): Promise<ManagedBooking | null> {
  const r = await db.query(
    `SELECT b.id::text AS id, b.contact_id::text AS contact_id, b.staff_user_id::text AS staff_user_id, b.staff_email, b.kind, b.starts_at, b.duration_min,
            b.client_name, b.client_email, b.client_phone, b.status, b.join_url, b.graph_event_id,
            b.crm_meeting_id::text AS crm_meeting_id, b.meeting_type_id::text AS meeting_type_id, b.sms_reminders,
            u.first_name AS staff_first_name, mt.name AS meeting_name
       FROM client_bookings b
       LEFT JOIN users u ON u.id = b.staff_user_id
       LEFT JOIN booking_meeting_types mt ON mt.id = b.meeting_type_id
      WHERE b.manage_token_hash = $1 LIMIT 1`, [tokenHash]);
  return (r.rows[0] as ManagedBooking) ?? null;
}

/** Removes the Outlook calendar event. Best effort: a failure is logged; the CRM records still say cancelled. */
export async function removeCalendarEvent(b: Pick<ManagedBooking, "id" | "staff_email" | "graph_event_id" | "staff_user_id">): Promise<boolean> {
  try {
    if (b.graph_event_id) {
      const { graphAppFetch, isAppGraphConfigured } = await import("../services/teams/graphAppClient.js");
      if (!isAppGraphConfigured()) return false;
      const resp = await graphAppFetch(`/users/${encodeURIComponent(b.staff_email)}/events/${encodeURIComponent(b.graph_event_id)}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: "Cancelled by the client." }),
      });
      if (!resp.ok) throw new Error(`graph_cancel_failed status=${resp.status}`);
      return true;
    }
    return false;
  } catch (err) {
    console.error("[booking] calendar event cancel failed; the CRM still shows it cancelled", { bookingId: b.id, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export async function markCancelled(db: Q, b: ManagedBooking, reason: "client_cancelled" | "rescheduled", rescheduledTo: string | null = null): Promise<void> {
  await db.query(`UPDATE client_bookings SET status = $2, cancelled_at = now(), rescheduled_to = $3::uuid WHERE id::text = $1`, [b.id, reason === "rescheduled" ? "rescheduled" : "cancelled", rescheduledTo]);
  if (b.crm_meeting_id) await db.query(`UPDATE crm_meetings SET status = 'cancelled', updated_at = now() WHERE id::text = $1`, [b.crm_meeting_id]);
}

// ------------------------------------------------------------------ reminders
export type ReminderDeps = {
  email: (to: string, subject: string, html: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  sms: (to: string, body: string) => Promise<{ ok: boolean; error?: string }>;
  now?: () => Date;
};

type DueRow = ManagedBooking & { which: "24h" | "1h"; sms_consent: boolean | null; opted_out: boolean | null };

/**
 * Sends the reminders now due. Each booking is claimed with an UPDATE ... RETURNING before anything is sent, so two
 * instances can never both send it. 24 h: bookings made at least 25 h ahead, now within 24 h. 1 h: made at least
 * 90 min ahead, now within the hour. A text needs the client's tick at booking, the contact's texting consent and no
 * STOP; the manage token is never stored, so reminders carry no change link (the confirmation email has it).
 */
export async function sendDueReminders(db: Q, deps: ReminderDeps): Promise<{ email: number; sms: number; errors: number }> {
  const now = deps.now?.() ?? new Date();
  const settings = await bookingSettings(db);
  const out = { email: 0, sms: 0, errors: 0 };
  for (const which of ["24h", "1h"] as const) {
    const col = which === "24h" ? "reminder_24h_at" : "reminder_1h_at";
    const within = which === "24h" ? "24 hours" : "1 hour";
    const lead = which === "24h" ? "25 hours" : "90 minutes";
    const wantEmail = which === "24h" ? settings.reminders.email_24h : settings.reminders.email_1h;
    const wantSms = which === "24h" ? settings.reminders.sms_24h : settings.reminders.sms_1h;
    if (!wantEmail && !wantSms) continue;
    const claimed = await db.query(
      `UPDATE client_bookings b SET ${col} = $1
        WHERE b.status = 'booked' AND b.${col} IS NULL
          AND b.starts_at > $1 AND b.starts_at <= $1::timestamptz + interval '${within}'
          AND b.created_at <= b.starts_at - interval '${lead}'
        RETURNING b.id::text AS id`, [now.toISOString()]);
    const ids = claimed.rows.map((r) => String(r.id));
    if (!ids.length) continue;
    const due = await db.query(
      `SELECT b.id::text AS id, b.contact_id::text AS contact_id, b.kind, b.starts_at, b.duration_min, b.client_name, b.client_email, b.client_phone,
              b.join_url, b.sms_reminders, u.first_name AS staff_first_name, mt.name AS meeting_name,
              c.sms_consent, COALESCE(c.sms_opt_out, false) AS opted_out
         FROM client_bookings b
         LEFT JOIN users u ON u.id = b.staff_user_id
         LEFT JOIN booking_meeting_types mt ON mt.id = b.meeting_type_id
         LEFT JOIN contacts c ON c.id = b.contact_id
        WHERE b.id::text = ANY($1::text[])`, [ids]);
    for (const row of due.rows as DueRow[]) {
      const msg: BookingMessageInput = {
        clientName: row.client_name, startsAt: new Date(row.starts_at).toISOString(), durationMin: Number(row.duration_min), kind: row.kind,
        staffFirstName: row.staff_first_name, meetingName: row.meeting_name || (row.kind === "phone" ? "Phone call" : "Video meeting"),
        joinUrl: row.join_url, phone: row.client_phone, manageToken: null,
      };
      const sent: string[] = [];
      if (wantEmail && row.client_email) {
        const m = reminderEmail(msg, which);
        const r = await deps.email(row.client_email, m.subject, m.html, m.text);
        if (r.ok) { out.email += 1; sent.push("email"); } else { out.errors += 1; console.warn("[booking] reminder email failed", { bookingId: row.id, which, error: r.error }); }
      }
      if (wantSms && row.sms_reminders && row.client_phone && row.sms_consent === true && !row.opted_out) {
        const r = await deps.sms(row.client_phone, reminderSms(msg, which));
        if (r.ok) { out.sms += 1; sent.push("sms"); } else { out.errors += 1; console.warn("[booking] reminder text failed", { bookingId: row.id, which, error: r.error }); }
      }
      if (sent.length) await logBookingTimeline(db, row.contact_id, "booking_reminder_sent", { booking_id: row.id, which, channels: sent });
    }
  }
  return out;
}

export function defaultReminderDeps(): ReminderDeps {
  return {
    async email(to, subject, html, text) {
      const { sendClientMail: sendPlanMail } = await import("../settingsPack/boreal.js");
      return sendPlanMail({ to: [to], subject, html, text });
    },
    async sms(to, body) {
      try {
        const { sendSms } = await import("../modules/notifications/sms.service.js");
        await sendSms({ to, message: body, track: { kind: "booking_reminder" } as any }, { enqueueOnFailure: false });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

export { mailboxOf };
