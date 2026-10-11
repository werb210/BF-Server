// BF_SERVER_v786_ROOM_RECORDINGS - conference rooms in the CRM. Twilio reports each room's conference
// start / end / join / leave to POST /api/webhooks/twilio/meeting-room-status?room=<roomId>. The first
// join creates a conferences row (meeting_room_id, friendly_name = the room's conference name) so the
// existing recording status route, call_recordings and transcription run unchanged. Every participant
// is recorded in conference_participants and matched to a contact (or a staff user); an unknown phone
// caller becomes a new contact. A saved room recording is linked to every matched participant contact
// and every attendee contact (call_recording_contacts), so it shows on each of their timelines.
import { pool } from "../db.js";
import { conferenceName } from "./meetingRooms.js";

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
const defaultQuery: Q = (sql, params) => pool.query(sql, params as any[]) as any;

export type RoomStatusInput = { roomId: string; event: string; callSid: string | null; conferenceSid: string | null; from: string | null };

/** +1XXXXXXXXXX for North American numbers; other digits with a +; null when it is not a phone number. */
export function toE164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.startsWith("client:") || s.startsWith("sip:")) return null;
  const d = s.replace(/[^0-9]/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  if (d.length >= 8 && d.length <= 15) return "+" + d;
  return null;
}

async function loadRoom(q: Q, roomId: string) {
  const r = await q(`SELECT id::text AS id, title, COALESCE(silo, 'BF') AS silo, contact_id::text AS contact_id, application_id, host_user_id::text AS host_user_id
                       FROM meeting_rooms WHERE id::text = $1 LIMIT 1`, [roomId]);
  return r.rows[0] ?? null;
}

async function openConference(q: Q, room: any, conferenceSid: string | null): Promise<string> {
  const existing = await q(`SELECT id::text AS id FROM conferences WHERE meeting_room_id::text = $1 AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [room.id]);
  if (existing.rows[0]) {
    if (conferenceSid) await q(`UPDATE conferences SET twilio_conference_sid = COALESCE(twilio_conference_sid, $2), updated_at = now() WHERE id = $1::uuid`, [existing.rows[0].id, conferenceSid]);
    return existing.rows[0].id;
  }
  const ins = await q(
    `INSERT INTO conferences (twilio_conference_sid, friendly_name, status, silo, created_by_user_id, application_id, contact_id, direction, started_at, meeting_room_id)
     VALUES ($1, $2, 'in-progress', $3, $4, $5, $6, 'meeting', now(), $7::uuid)
     ON CONFLICT (meeting_room_id) WHERE meeting_room_id IS NOT NULL AND ended_at IS NULL DO NOTHING
     RETURNING id::text AS id`,
    [conferenceSid, conferenceName(room.id), room.silo, room.host_user_id, room.application_id, room.contact_id, room.id]);
  if (ins.rows[0]) return ins.rows[0].id;
  const again = await q(`SELECT id::text AS id FROM conferences WHERE meeting_room_id::text = $1 AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [room.id]);
  return again.rows[0].id;
}

/** Phone -> contact (phone or secondary phone, last 10 digits, the room's silo); unknown -> a new contact. */
export async function contactForPhone(q: Q, silo: string, phone: string): Promise<{ id: string; created: boolean }> {
  const found = await q(
    `SELECT id::text AS id FROM contacts
      WHERE silo = $1 AND merged_into_id IS NULL
        AND (right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace($2::text, '[^0-9]', '', 'g'), 10)
          OR right(regexp_replace(COALESCE(secondary_phone, ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace($2::text, '[^0-9]', '', 'g'), 10))
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [silo, phone]);
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const ins = await q(
    `INSERT INTO contacts (name, phone, silo, tags, created_at, updated_at) VALUES ($1, $2, $3, ARRAY['conference_caller'], now(), now()) RETURNING id::text AS id`,
    ["Caller " + phone, phone, silo]);
  return { id: ins.rows[0].id, created: true };
}

async function userForIdentity(q: Q, identity: string): Promise<string | null> {
  const bare = identity.replace(/^(staff|user)[_:-]/i, "");
  const r = await q(`SELECT id::text AS id FROM users WHERE id::text = $1 OR lower(email) = lower($1) OR id::text = $2 LIMIT 1`, [identity, bare]);
  return r.rows[0]?.id ?? null;
}

/** Every contact a room recording belongs to: matched participants, invited attendees (by id or email), the room's contact. */
export async function roomContactIds(q: Q, conferenceId: string): Promise<string[]> {
  const r = await q(
    `SELECT DISTINCT x.contact_id FROM (
        SELECT cp.contact_id::text AS contact_id FROM conference_participants cp WHERE cp.conference_id = $1::uuid AND cp.contact_id IS NOT NULL
        UNION ALL
        SELECT mp.contact_id::text FROM conferences cf JOIN meeting_participants mp ON mp.room_id = cf.meeting_room_id
         WHERE cf.id = $1::uuid AND mp.contact_id IS NOT NULL
        UNION ALL
        SELECT c.id::text FROM conferences cf JOIN meeting_participants mp ON mp.room_id = cf.meeting_room_id
          JOIN meeting_rooms mr ON mr.id = cf.meeting_room_id
          JOIN contacts c ON lower(c.email) = lower(mp.email) AND c.silo = COALESCE(mr.silo, 'BF') AND c.merged_into_id IS NULL
         WHERE cf.id = $1::uuid AND COALESCE(mp.email, '') <> ''
        UNION ALL
        SELECT mr.contact_id::text FROM conferences cf JOIN meeting_rooms mr ON mr.id = cf.meeting_room_id WHERE cf.id = $1::uuid AND mr.contact_id IS NOT NULL
     ) x WHERE x.contact_id IS NOT NULL`, [conferenceId]);
  return r.rows.map((row: any) => String(row.contact_id));
}

/** Links every recording of a room conference to every room contact. Idempotent. */
export async function linkRoomRecordings(conferenceId: string, q: Q = defaultQuery): Promise<number> {
  const ids = await roomContactIds(q, conferenceId);
  if (!ids.length) return 0;
  const r = await q(
    `INSERT INTO call_recording_contacts (recording_id, contact_id)
     SELECT cr.id, c::uuid FROM call_recordings cr CROSS JOIN unnest($2::text[]) AS c
      WHERE cr.conference_id = $1::uuid
     ON CONFLICT (recording_id, contact_id) DO NOTHING`, [conferenceId, ids]);
  return Number(r.rowCount ?? 0);
}

export async function handleRoomStatus(input: RoomStatusInput, q: Q = defaultQuery): Promise<{ conferenceId: string | null }> {
  const room = await loadRoom(q, input.roomId);
  if (!room) return { conferenceId: null };
  const event = input.event.replace(/^conference-/, "").replace(/^participant-/, "");
  const { emitAutomationEvent } = await import("../modules/automation/automationEngine.js");

  if (event === "start" || event === "join") {
    const conferenceId = await openConference(q, room, input.conferenceSid);
    if (event === "join" && input.callSid) {
      const from = String(input.from ?? "");
      const identity = from.startsWith("client:") ? from.slice(7) : null;
      const phone = identity ? null : toE164(from);
      let contactId: string | null = null;
      let userId: string | null = null;
      if (identity) userId = await userForIdentity(q, identity);
      else if (phone) {
        const c = await contactForPhone(q, room.silo, phone);
        contactId = c.id;
        if (c.created) void emitAutomationEvent("contact.created", { silo: room.silo, contactId, data: { source: "conference", meeting_room_id: room.id } });
      }
      await q(
        `INSERT INTO conference_participants (conference_id, twilio_call_sid, identity, phone_number, kind, role, status, joined_at, contact_id, user_id)
         VALUES ($1::uuid, $2, $3, $4, $5, 'participant', 'joined', now(), $6::uuid, $7::uuid)
         ON CONFLICT (twilio_call_sid) DO UPDATE SET status = 'joined', joined_at = COALESCE(conference_participants.joined_at, now()),
           contact_id = COALESCE(conference_participants.contact_id, EXCLUDED.contact_id), user_id = COALESCE(conference_participants.user_id, EXCLUDED.user_id)`,
        [conferenceId, input.callSid, identity, phone, identity ? "staff" : "pstn", contactId, userId]);
    }
    return { conferenceId };
  }

  const open = await q(`SELECT id::text AS id FROM conferences WHERE meeting_room_id::text = $1 AND ended_at IS NULL ORDER BY created_at DESC LIMIT 1`, [room.id]);
  const conferenceId: string | null = open.rows[0]?.id ?? null;
  if (event === "leave" && input.callSid) {
    await q(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE twilio_call_sid = $1`, [input.callSid]);
    return { conferenceId };
  }
  if (event === "end" && conferenceId) {
    await q(`UPDATE conferences SET status = 'completed', ended_at = now(), updated_at = now() WHERE id = $1::uuid`, [conferenceId]);
    await q(`UPDATE conference_participants SET status = 'left', left_at = COALESCE(left_at, now()) WHERE conference_id = $1::uuid AND status <> 'left'`, [conferenceId]);
    await q(`UPDATE meeting_rooms SET completed_at = now(), updated_at = now() WHERE id::text = $1`, [room.id]);
    await linkRoomRecordings(conferenceId, q);
    for (const contactId of await roomContactIds(q, conferenceId)) {
      void emitAutomationEvent("meeting.completed", { silo: room.silo, contactId, applicationId: room.application_id ?? null, data: { meeting_room_id: room.id, conference_id: conferenceId, title: room.title } });
    }
  }
  return { conferenceId };
}
