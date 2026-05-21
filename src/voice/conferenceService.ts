// BF_SERVER_BLOCK_v500 -- conference DB layer (no Twilio calls here)
import { pool } from "../db.js";

export type ParticipantKind = "staff" | "pstn" | "client_miniportal";
export type ParticipantRole = "moderator" | "participant";

export interface ConferenceRow {
  id: string;
  twilio_conference_sid: string | null;
  friendly_name: string;
  status: string;
  silo: string;
  created_by_user_id: string | null;
  application_id: string | null;
  contact_id: string | null;
  direction: string;
  recording_sid: string | null;
  recording_url: string | null;
  recording_status: string | null;
  recording_paused: boolean;
  started_at: string | null;
  ended_at: string | null;
}

export interface ParticipantRow {
  id: string;
  conference_id: string;
  twilio_call_sid: string | null;
  twilio_participant_label: string | null;
  identity: string | null;
  phone_number: string | null;
  kind: ParticipantKind;
  role: ParticipantRole;
  status: string;
  muted: boolean;
  on_hold: boolean;
  joined_at: string | null;
  left_at: string | null;
}

export async function createConference(args: {
  friendlyName: string;
  silo?: string;
  createdByUserId?: string;
  applicationId?: string;
  contactId?: string;
  direction?: "outbound" | "inbound";
}): Promise<ConferenceRow> {
  const { rows } = await pool.query<ConferenceRow>(
    `INSERT INTO conferences (friendly_name, silo, created_by_user_id, application_id, contact_id, direction)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [args.friendlyName, args.silo ?? "BF", args.createdByUserId ?? null,
     args.applicationId ?? null, args.contactId ?? null, args.direction ?? "outbound"]
  );
  return rows[0];
}

export async function getConference(id: string): Promise<ConferenceRow | null> {
  const { rows } = await pool.query<ConferenceRow>(`SELECT * FROM conferences WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getConferenceByFriendlyName(friendlyName: string): Promise<ConferenceRow | null> {
  const { rows } = await pool.query<ConferenceRow>(
    `SELECT * FROM conferences WHERE friendly_name = $1 ORDER BY created_at DESC LIMIT 1`,
    [friendlyName]
  );
  return rows[0] ?? null;
}

export async function updateConference(id: string, patch: Partial<ConferenceRow>): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map(k => (patch as any)[k]);
  await pool.query(`UPDATE conferences SET ${sets}, updated_at = now() WHERE id = $1`, [id, ...values]);
}

export async function addParticipant(args: {
  conferenceId: string;
  identity?: string;
  phoneNumber?: string;
  kind: ParticipantKind;
  role?: ParticipantRole;
  status?: string;
}): Promise<ParticipantRow> {
  const { rows } = await pool.query<ParticipantRow>(
    `INSERT INTO conference_participants (conference_id, identity, phone_number, kind, role, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [args.conferenceId, args.identity ?? null, args.phoneNumber ?? null,
     args.kind, args.role ?? "participant", args.status ?? "invited"]
  );
  return rows[0];
}

export async function updateParticipantByCallSid(callSid: string, patch: Partial<ParticipantRow>): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map(k => (patch as any)[k]);
  await pool.query(`UPDATE conference_participants SET ${sets} WHERE twilio_call_sid = $1`, [callSid, ...values]);
}

export async function attachCallSidToParticipant(participantId: string, callSid: string): Promise<void> {
  await pool.query(
    `UPDATE conference_participants SET twilio_call_sid = $2 WHERE id = $1`,
    [participantId, callSid]
  );
}

export async function listParticipants(conferenceId: string): Promise<ParticipantRow[]> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT * FROM conference_participants WHERE conference_id = $1 ORDER BY created_at ASC`,
    [conferenceId]
  );
  return rows;
}

export async function findParticipantByCallSid(callSid: string): Promise<ParticipantRow | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT * FROM conference_participants WHERE twilio_call_sid = $1`,
    [callSid]
  );
  return rows[0] ?? null;
}
