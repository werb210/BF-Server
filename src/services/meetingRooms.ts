import { ALBERTA_TZ } from "../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_MEETING_ROOMS_v736 - dial-in conference rooms with access codes and join links.
// A room opens 15 minutes before its start and stays open for its length plus 2 hours, so a
// code can't be reused to get into someone else's meeting days later.
import { randomInt, randomUUID } from "node:crypto";
import { pool } from "../db.js";

export const DIAL_IN_DISPLAY = "(866) 631-8939";
export const DIAL_IN_E164 = "+18666318939";
export const OPEN_BEFORE_MIN = 15;
export const STAY_OPEN_AFTER_MIN = 120;

export type MeetingRoom = { id: string; code: string; slug: string; title: string; host_user_id: string | null; application_id: string | null; contact_id: string | null; starts_at: string; duration_min: number; status: string };

export const conferenceName = (id: string) => "boreal-meet-" + id;
const newSlug = () => randomUUID().replace(/-/g, "").slice(0, 12);

export function isOpen(room: Pick<MeetingRoom, "starts_at" | "duration_min" | "status">, now = new Date()): boolean {
  if (room.status === "cancelled") return false;
  const start = new Date(room.starts_at).getTime();
  const opens = start - OPEN_BEFORE_MIN * 60_000;
  const closes = start + (room.duration_min + STAY_OPEN_AFTER_MIN) * 60_000;
  const t = now.getTime();
  return t >= opens && t <= closes;
}

/** One-tap dial string for phones: dial the 866, pick option 3, enter the code. */
export function oneTapDial(code: string): string { return DIAL_IN_E164 + ",,3,,," + code + "#"; }

export function joinUrl(slug: string): string {
  const base = (process.env.PUBLIC_SERVER_URL || "https://server.boreal.financial").replace(/[/]+$/, "");
  return base + "/api/meetings/join/" + slug;
}

export function inviteText(room: Pick<MeetingRoom, "title" | "code" | "slug" | "starts_at">): string {
  const when = new Date(room.starts_at).toLocaleString("en-CA", { timeZone: ALBERTA_TZ, dateStyle: "full", timeStyle: "short" });
  return [
    room.title,
    when + " (Alberta time)",
    "",
    "Join by phone: call " + DIAL_IN_DISPLAY + ", press 3, then enter access code " + room.code + " and press #.",
    "Meeting page: " + joinUrl(room.slug),
  ].join(String.fromCharCode(10));
}

/** A 6-digit code not already used by another room that is scheduled near the same time. */
async function freeCode(startsAt: Date): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const code = String(randomInt(100000, 1000000));
    const clash = await pool.query(
      `SELECT 1 FROM meeting_rooms WHERE code = $1 AND status <> 'cancelled'
          AND starts_at BETWEEN $2::timestamptz - interval '3 days' AND $2::timestamptz + interval '3 days' LIMIT 1`,
      [code, startsAt.toISOString()],
    );
    if (!clash.rows.length) return code;
  }
  throw new Error("could_not_allocate_code");
}

export async function createRoom(input: { title: string; startsAt: Date; durationMin?: number; hostUserId: string | null; applicationId?: string | null; contactId?: string | null }): Promise<MeetingRoom> {
  const code = await freeCode(input.startsAt);
  const { rows } = await pool.query<MeetingRoom>(
    `INSERT INTO meeting_rooms (id, code, slug, title, host_user_id, application_id, contact_id, starts_at, duration_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id::text, code, slug, title, host_user_id::text, application_id, contact_id::text, starts_at, duration_min, status`,
    [randomUUID(), code, newSlug(), input.title.slice(0, 160), input.hostUserId, input.applicationId ?? null, input.contactId ?? null, input.startsAt.toISOString(), Math.min(Math.max(input.durationMin ?? 60, 15), 480)],
  );
  return rows[0]!;
}

/** The open room for a code entered on the phone, if any. */
export async function findOpenRoomByCode(code: string, now = new Date()): Promise<MeetingRoom | null> {
  const clean = String(code ?? "").replace(/[^0-9]/g, "");
  if (clean.length !== 6) return null;
  const { rows } = await pool.query<MeetingRoom>(
    `SELECT id::text, code, slug, title, host_user_id::text, application_id, contact_id::text, starts_at, duration_min, status
       FROM meeting_rooms WHERE code = $1 AND status <> 'cancelled'
      ORDER BY abs(extract(epoch FROM (starts_at - $2::timestamptz))) LIMIT 5`,
    [clean, now.toISOString()],
  );
  return rows.find((r) => isOpen(r, now)) ?? null;
}

export async function roomBySlug(slug: string): Promise<MeetingRoom | null> {
  const { rows } = await pool.query<MeetingRoom>(
    `SELECT id::text, code, slug, title, host_user_id::text, application_id, contact_id::text, starts_at, duration_min, status
       FROM meeting_rooms WHERE slug = $1 LIMIT 1`, [String(slug ?? "").slice(0, 40)]);
  return rows[0] ?? null;
}

// BF_SERVER_MEETING_PARTICIPANTS_v737 - invited people (up to 10 per room, host included),
// name search across CRM contacts and staff, and an email invite with the code and link.
export const MAX_PEOPLE = 10;
export type Person = { contactId?: string | null; userId?: string | null; name: string; email?: string | null; phone?: string | null };
export type Participant = Person & { id: string; invited_at: string | null };

export async function listParticipants(roomId: string): Promise<Participant[]> {
  const { rows } = await pool.query(
    `SELECT id::text, contact_id::text AS "contactId", user_id::text AS "userId", name, email, phone, invited_at
       FROM meeting_participants WHERE room_id::text = $1 ORDER BY created_at`, [roomId]);
  return rows as Participant[];
}

/** Adds people not already on the room; refuses to go over 10 including the host. */
export async function addParticipants(room: MeetingRoom, people: Person[]): Promise<{ added: Participant[]; refused: number }> {
  const existing = await listParticipants(room.id);
  const hostCounts = room.host_user_id && !existing.some((p) => p.userId === room.host_user_id) ? 1 : 0;
  let room_left = MAX_PEOPLE - hostCounts - existing.length;
  const seen = new Set(existing.map((p) => (p.contactId || p.userId || p.email || p.phone || p.name).toLowerCase()));
  const added: Participant[] = [];
  let refused = 0;
  for (const p of people) {
    const name = String(p.name ?? "").trim().slice(0, 120);
    if (!name) continue;
    const key = String(p.contactId || p.userId || p.email || p.phone || name).toLowerCase();
    if (seen.has(key)) continue;
    if (room_left <= 0) { refused += 1; continue; }
    const { rows } = await pool.query(
      `INSERT INTO meeting_participants (id, room_id, contact_id, user_id, name, email, phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id::text, contact_id::text AS "contactId", user_id::text AS "userId", name, email, phone, invited_at`,
      [randomUUID(), room.id, p.contactId || null, p.userId || null, name, p.email?.trim() || null, p.phone?.trim() || null]);
    added.push(rows[0] as Participant);
    seen.add(key); room_left -= 1;
  }
  return { added, refused };
}

export async function removeParticipant(roomId: string, participantId: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM meeting_participants WHERE room_id::text = $1 AND id::text = $2`, [roomId, participantId]);
  return Boolean(r.rowCount);
}

/** Name / email / phone search across Boreal Financial CRM contacts and active staff. */
export async function searchPeople(q: string): Promise<Array<Person & { kind: "contact" | "staff"; detail: string }>> {
  const term = String(q ?? "").trim();
  if (term.length < 2) return [];
  const like = "%" + term.replace(/[%_]/g, "") + "%";
  const contacts = await pool.query(
    `SELECT id::text AS "contactId", COALESCE(NULLIF(name, ''), trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))) AS name,
            email, phone, company_name
       FROM contacts
      WHERE silo = 'BF' AND merged_into_id IS NULL
        AND (name ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1 OR company_name ILIKE $1 OR phone ILIKE $1)
      ORDER BY updated_at DESC NULLS LAST LIMIT 8`, [like]);
  const staff = await pool.query(
    `SELECT id::text AS "userId", trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, email, phone_number AS phone
       FROM users
      WHERE COALESCE(active, true) AND (first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1)
      ORDER BY first_name LIMIT 5`, [like]);
  return [
    ...staff.rows.filter((r: any) => r.name).map((r: any) => ({ ...r, kind: "staff" as const, detail: "Boreal staff" })),
    ...contacts.rows.filter((r: any) => r.name).map((r: any) => ({ contactId: r.contactId, name: r.name, email: r.email, phone: r.phone, kind: "contact" as const, detail: [r.company_name, r.email || r.phone].filter(Boolean).join(" - ") })),
  ];
}

// BF_SERVER_MEETING_NOTIFY_v741 - invites now go out through services/meetingNotify.ts (Outlook, text, email).
