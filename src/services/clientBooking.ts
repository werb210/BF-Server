import { ALBERTA_TZ } from "../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_CLIENT_BOOKING_v738 - clients book a 30-minute phone call or Teams meeting.
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { graphAppFetch, isAppGraphConfigured } from "./teams/graphAppClient.js";

export const TZ = ALBERTA_TZ;
export const SLOT_MIN = 30;
export const DAY_START_H = 9;
export const DAY_END_H = 17;
export const MIN_NOTICE_H = 2;
export type BookingKind = "phone" | "teams";
// BF_SERVER_BOOKING_MAILBOX_v749 / BF_SERVER_INTAKE_ROUND_ROBIN_v749 - email is the login (used for link names); mailbox is the
// Outlook calendar. They differ: Andrew logs in as andrew@ but his mailbox is andrew.p@, and
// andrew@ does not exist in the tenant, so events posted to the login email failed.
export type Staff = { id: string; email: string; first_name: string | null; signed_in?: boolean; mailbox?: string };
export const mailboxOf = (staff: Staff): string => (staff.mailbox || staff.email).toLowerCase();

function tzOffsetMin(at: Date, tz = TZ): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - at.getTime()) / 60_000);
}
export function albertaTime(y: number, m: number, d: number, h: number, min = 0): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min));
  return new Date(guess.getTime() - tzOffsetMin(guess) * 60_000);
}
function albertaYmdDow(at: Date): { y: number; m: number; d: number; dow: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)) };
}
export function candidateSlots(now: Date, days = 14): Date[] {
  const out: Date[] = [];
  const earliest = now.getTime() + MIN_NOTICE_H * 3_600_000;
  for (let i = 0; i <= days; i += 1) {
    const day = albertaYmdDow(new Date(now.getTime() + i * 86_400_000));
    if (day.dow === 0 || day.dow === 6) continue;
    for (let h = DAY_START_H; h < DAY_END_H; h += 1) for (const min of [0, 30]) {
      const t = albertaTime(day.y, day.m, day.d, h, min);
      if (t.getTime() >= earliest && !out.some((x) => x.getTime() === t.getTime())) out.push(t);
    }
  }
  return out;
}
export function overlaps(slot: Date, busy: Array<{ start: Date; end: Date }>): boolean {
  const s = slot.getTime(), e = s + SLOT_MIN * 60_000;
  return busy.some((b) => b.start.getTime() < e && b.end.getTime() > s);
}
export async function bookableStaff(): Promise<Staff[]> {
  const only = String(process.env.BOOKING_STAFF_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // swallow-ok: this query has no catch; the guardrail's scan reaches a later HTTP error-body read
  const { rows } = await pool.query<Staff>(`SELECT id::text, lower(email) AS email, first_name,
        lower(COALESCE(NULLIF(trim(o365_user_email), ''), email)) AS mailbox,
        (last_login_at IS NOT NULL OR o365_refresh_token IS NOT NULL) AS signed_in
      FROM users
      WHERE COALESCE(active, true) AND deleted_at IS NULL AND COALESCE(disabled, false) = false
        AND role IN ('Admin', 'Staff') AND email ILIKE '%@boreal.financial'
      ORDER BY first_name NULLS LAST`);
  return only.length ? rows.filter((r) => only.includes(r.email) || only.includes(mailboxOf(r))) : rows;
}
// BF_SERVER_INTAKE_ROUND_ROBIN_v749 - the general booking page (/book) and the client portal's
// "Book a call" go to the Intake team: every staff member signed in to Office 365 except the
// people in BOOKING_INTAKE_EXCLUDE (default: Andrew). Personal links (/book-todd) are unchanged.
export const DEFAULT_INTAKE_EXCLUDE = "andrew@boreal.financial,andrew.p@boreal.financial";
export function intakeExcludes(): string[] {
  return String(process.env.BOOKING_INTAKE_EXCLUDE ?? DEFAULT_INTAKE_EXCLUDE).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
export function intakeTeam(staff: Staff[]): Staff[] {
  const exclude = intakeExcludes();
  return staff.filter((s) => s.signed_in !== false && !exclude.includes(s.email.toLowerCase()) && !exclude.includes(mailboxOf(s)));
}
// Round robin: of the people free at the chosen time, whoever was booked least recently goes
// next; someone never booked goes first. Ties fall back to first name order.
export function roundRobinPick(freeIds: string[], lastBooked: Map<string, number>): string | null {
  if (!freeIds.length) return null;
  return [...freeIds].sort((a, b) => (lastBooked.get(a) ?? -1) - (lastBooked.get(b) ?? -1))[0]!;
}
export async function busyTimes(emails: string[], from: Date, to: Date): Promise<Map<string, Array<{ start: Date; end: Date }>>> {
  const out = new Map<string, Array<{ start: Date; end: Date }>>();
  if (!emails.length || !isAppGraphConfigured()) return out;
  const resp = await graphAppFetch(`/users/${encodeURIComponent(emails[0]!)}/calendar/getSchedule`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: 'outlook.timezone="UTC"' },
    body: JSON.stringify({ schedules: emails, startTime: { dateTime: from.toISOString().slice(0, 19), timeZone: "UTC" }, endTime: { dateTime: to.toISOString().slice(0, 19), timeZone: "UTC" }, availabilityViewInterval: SLOT_MIN }),
  });
  if (!resp.ok) throw new Error("graph_getschedule_failed status=" + resp.status + " " + (await resp.text().catch(() => "")).slice(0, 200)); // swallow-ok
  const json = (await resp.json()) as { value?: Array<{ scheduleId: string; scheduleItems?: Array<{ status?: string; start: { dateTime: string }; end: { dateTime: string } }> }> };
  for (const s of json.value ?? []) out.set(s.scheduleId.toLowerCase(), (s.scheduleItems ?? []).filter((i) => i.status !== "free").map((i) => ({ start: new Date(i.start.dateTime + "Z"), end: new Date(i.end.dateTime + "Z") })));
  return out;
}
export async function openSlots(now: Date, staffId: string | null, days = 14): Promise<Array<{ startsAt: string; staffIds: string[] }>> {
  const everyone = await bookableStaff();
  const staff = staffId ? everyone.filter((s) => s.id === staffId) : intakeTeam(everyone);
  const slots = candidateSlots(now, days);
  if (!slots.length || !staff.length) return [];
  const busy = await busyTimes(staff.map(mailboxOf), slots[0]!, new Date(slots[slots.length - 1]!.getTime() + SLOT_MIN * 60_000));
  const taken = await pool.query<{ staff_user_id: string | null; staff_email: string; starts_at: string }>(`SELECT staff_user_id::text, lower(staff_email) AS staff_email, starts_at FROM client_bookings WHERE status = 'booked' AND starts_at >= $1`, [slots[0]!.toISOString()]);
  const isTaken = (s: Staff, t: Date) => taken.rows.some((b) => (b.staff_user_id === s.id || b.staff_email === s.email || b.staff_email === mailboxOf(s)) && new Date(b.starts_at).getTime() === t.getTime());
  return slots.map((t) => ({ startsAt: t.toISOString(), staffIds: staff.filter((s) => !overlaps(t, busy.get(mailboxOf(s)) ?? []) && !isTaken(s, t)).map((s) => s.id) })).filter((x) => x.staffIds.length > 0);
}
export async function createBooking(input: { kind: BookingKind; startsAt: Date; staffId: string | null; name: string; email: string; phone: string | null; notes: string | null; now?: Date }): Promise<{ ok: true; booking: { id: string; startsAt: string; staffFirstName: string | null; kind: BookingKind; joinUrl: string | null } } | { ok: false; reason: string }> {
  const match = (await openSlots(input.now ?? new Date(), input.staffId, 15)).find((s) => new Date(s.startsAt).getTime() === input.startsAt.getTime());
  if (!match) return { ok: false, reason: "slot_taken" };
  const everyone = await bookableStaff();
  const staffList = input.staffId ? everyone : intakeTeam(everyone);
  const last = await pool.query<{ staff_user_id: string; last_at: string }>(`SELECT staff_user_id::text, max(created_at) AS last_at FROM client_bookings WHERE staff_user_id IS NOT NULL GROUP BY 1`);
  const lastAssigned = new Map(last.rows.map((r) => [r.staff_user_id, new Date(r.last_at).getTime()] as [string, number]));
  const pickId = input.staffId ?? roundRobinPick(match.staffIds, lastAssigned)!;
  const staff = staffList.find((s) => s.id === pickId);
  if (!staff) return { ok: false, reason: "staff_unavailable" };
  const end = new Date(input.startsAt.getTime() + SLOT_MIN * 60_000);
  const subject = (input.kind === "teams" ? "Teams meeting" : "Phone call") + " with " + input.name + " - Boreal Financial";
  const bodyLines = [input.kind === "phone" ? "We will call you at " + (input.phone ?? "the number you gave") + "." : "Join with the Teams link in this invitation.", input.notes ? "Notes: " + input.notes : ""].filter(Boolean);
  const resp = await graphAppFetch(`/users/${encodeURIComponent(mailboxOf(staff))}/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    subject, body: { contentType: "Text", content: bodyLines.join(String.fromCharCode(10)) }, start: { dateTime: input.startsAt.toISOString().slice(0, 19), timeZone: "UTC" }, end: { dateTime: end.toISOString().slice(0, 19), timeZone: "UTC" }, attendees: [{ emailAddress: { address: input.email, name: input.name }, type: "required" }], location: { displayName: input.kind === "phone" ? "Phone call - Boreal calls " + (input.phone ?? "") : "Microsoft Teams" }, isOnlineMeeting: input.kind === "teams", ...(input.kind === "teams" ? { onlineMeetingProvider: "teamsForBusiness" } : {}), allowNewTimeProposals: false,
  }) });
  if (!resp.ok) throw new Error("graph_create_event_failed status=" + resp.status + " " + (await resp.text().catch(() => "")).slice(0, 200)); // swallow-ok
  const ev = (await resp.json()) as { id?: string; onlineMeeting?: { joinUrl?: string } };
  const contact = await pool.query<{ id: string }>(`SELECT id::text FROM contacts WHERE silo = 'BF' AND merged_into_id IS NULL AND (lower(email) = lower($1) OR ($2::text IS NOT NULL AND right(regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g'), 10) = right(regexp_replace($2::text, '[^0-9]', '', 'g'), 10))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [input.email, input.phone]);
  let contactId = contact.rows[0]?.id ?? null;
  if (!contactId) {
    const ins = await pool.query<{ id: string }>(`INSERT INTO contacts (id, name, email, phone, silo, tags, created_at, updated_at) VALUES ($1,$2,$3,$4,'BF',ARRAY['booked_call'],now(),now()) RETURNING id::text`, [randomUUID(), input.name, input.email, input.phone]);
    contactId = ins.rows[0]!.id;
  }
  const id = randomUUID();
  await pool.query(`INSERT INTO client_bookings (id, contact_id, staff_user_id, staff_email, kind, starts_at, duration_min, client_name, client_email, client_phone, notes, graph_event_id, join_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, contactId, staff.id, mailboxOf(staff), input.kind, input.startsAt.toISOString(), SLOT_MIN, input.name, input.email, input.phone, input.notes, ev.id ?? null, ev.onlineMeeting?.joinUrl ?? null]);
  return { ok: true, booking: { id, startsAt: input.startsAt.toISOString(), staffFirstName: staff.first_name, kind: input.kind, joinUrl: ev.onlineMeeting?.joinUrl ?? null } };
}
