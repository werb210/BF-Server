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
  const when = new Date(room.starts_at).toLocaleString("en-CA", { timeZone: "America/Edmonton", dateStyle: "full", timeStyle: "short" });
  return [
    room.title,
    when + " (Mountain time)",
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
