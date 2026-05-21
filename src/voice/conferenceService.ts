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
  direction?: string;
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
  identity?: string | null;
  phoneNumber?: string | null;
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

// v599 compat shim begin -----------------------------------------------------
// Names + helpers expected by Codex-generated route files. Pure additive.
import { createRequire as __req_v599 } from "module";
import { publishToUser as __pub, publishToUsers as __pubMany, publishBroadcast as __pubAll } from "./sseBus.js";

const __require_v599 = __req_v599(import.meta.url);
const __twilio_v599 = __require_v599("twilio");

function __getTwilio_v599() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error("twilio_not_configured");
  return __twilio_v599(sid, tok);
}
function __baseUrl_v599(): string {
  return process.env.PUBLIC_BASE_URL || "https://server.boreal.financial";
}
function __callerId_v599(): string {
  return process.env.TWILIO_CALLER_ID
    || process.env.TWILIO_DEFAULT_OUTBOUND_CALLER_ID
    || process.env.TWILIO_FROM_NUMBER
    || process.env.TWILIO_PHONE_NUMBER
    || "";
}

// Name aliases
export const getConferenceByFriendly = getConferenceByFriendlyName;
export const getConferenceById = getConference;
export const getParticipantBySid = findParticipantByCallSid;
export const addParticipantRow = addParticipant;
export const setParticipantCallSid = attachCallSidToParticipant;

export async function getParticipantById(participantId: string): Promise<ParticipantRow | null> {
  const { pool } = await import("../db.js");
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT * FROM conference_participants WHERE id = $1`, [participantId]
  );
  return rows[0] ?? null;
}

export async function notifyConferenceState(conferenceId: string): Promise<void> {
  const c = await getConference(conferenceId);
  if (!c) return;
  const parts = await listParticipants(conferenceId);
  if (c.created_by_user_id) __pub(c.created_by_user_id, "conference.update", { conference: c, participants: parts });
  const staffIds = parts.filter(p => p.kind === "staff" && p.identity).map(p => p.identity as string);
  if (staffIds.length > 0) __pubMany(staffIds, "conference.update", { conference: c, participants: parts });
}

export interface DialIntoConferenceArgs {
  conferenceFriendlyName?: string;
  friendlyName?: string;
  conference?: string;
  conf?: string;
  phoneNumber?: string;
  phone?: string;
  to?: string;
  identity?: string;
  role?: "moderator" | "participant";
  endOnExit?: boolean;
}

function __resolveFriendly(a: DialIntoConferenceArgs): string {
  return String(a.conferenceFriendlyName ?? a.friendlyName ?? a.conference ?? a.conf ?? "");
}

export async function dialPstnIntoConference(args: DialIntoConferenceArgs): Promise<{ callSid: string }> {
  const friendly = __resolveFriendly(args);
  const phone = String(args.phoneNumber ?? args.phone ?? args.to ?? "");
  if (!friendly || !phone) throw new Error("dialPstnIntoConference: missing args");
  const role = args.role ?? "participant";
  const endOnExit = !!args.endOnExit;
  const tw = __getTwilio_v599();
  const call = await tw.calls.create({
    to: phone, from: __callerId_v599(),
    url: `${__baseUrl_v599()}/api/webhooks/twilio/voice/conf-join?conf=${encodeURIComponent(friendly)}&role=${role}&endOnExit=${endOnExit}`,
    method: "POST",
    statusCallback: `${__baseUrl_v599()}/api/webhooks/twilio/voice/call-status`,
    statusCallbackEvent: ["initiated","ringing","answered","completed"],
    statusCallbackMethod: "POST",
  });
  return { callSid: call.sid };
}

export async function dialClientIntoConference(args: DialIntoConferenceArgs): Promise<{ callSid: string }> {
  const friendly = __resolveFriendly(args);
  const identity = String(args.identity ?? "");
  if (!friendly || !identity) throw new Error("dialClientIntoConference: missing args");
  const role = args.role ?? "moderator";
  const endOnExit = args.endOnExit ?? (role === "moderator");
  const tw = __getTwilio_v599();
  const call = await tw.calls.create({
    to: `client:${identity}`, from: __callerId_v599(),
    url: `${__baseUrl_v599()}/api/webhooks/twilio/voice/conf-join?conf=${encodeURIComponent(friendly)}&role=${role}&endOnExit=${endOnExit}`,
    method: "POST",
    statusCallback: `${__baseUrl_v599()}/api/webhooks/twilio/voice/call-status`,
    statusCallbackEvent: ["initiated","ringing","answered","completed"],
    statusCallbackMethod: "POST",
    timeout: 25,
  });
  return { callSid: call.sid };
}

export async function cancelPendingParticipantCall(participantId: string): Promise<void> {
  const p = await getParticipantById(participantId);
  if (!p?.twilio_call_sid) return;
  if (["completed","canceled","left"].includes(p.status)) return;
  try {
    const tw = __getTwilio_v599();
    await tw.calls(p.twilio_call_sid).update({ status: "canceled" });
  } catch { /* best-effort */ }
}

export async function broadcastIncomingRing(conferenceId: string, fromLabel: string): Promise<void> {
  const parts = await listParticipants(conferenceId);
  const staffIds = parts.filter(p => p.kind === "staff" && p.identity).map(p => p.identity as string);
  if (staffIds.length === 0) {
    __pubAll("incoming.call", { conferenceId, from: fromLabel });
    return;
  }
  __pubMany(staffIds, "incoming.call", { conferenceId, from: fromLabel });
}

export async function broadcastIncomingAnswered(conferenceId: string): Promise<void> {
  const parts = await listParticipants(conferenceId);
  const staffIds = parts.filter(p => p.kind === "staff" && p.identity).map(p => p.identity as string);
  __pubMany(staffIds, "incoming.answered", { conferenceId });
}
// v599 compat shim end -------------------------------------------------------

