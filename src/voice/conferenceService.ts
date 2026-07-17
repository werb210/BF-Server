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
  friendlyName?: string;
  silo?: string;
  createdByUserId?: string | null;
  applicationId?: string | null;
  contactId?: string | null;
  direction?: string;
}): Promise<ConferenceRow> {
  const __friendly = args.friendlyName && args.friendlyName.length > 0
    ? args.friendlyName
    : `bf-${Date.now()}-${(args.createdByUserId ?? "anon").slice(0, 8)}`;
  const { rows } = await pool.query<ConferenceRow>(
    `INSERT INTO conferences (friendly_name, silo, created_by_user_id, application_id, contact_id, direction)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [__friendly, args.silo ?? "BF", args.createdByUserId ?? null,
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
  displayName?: string | null;
  [k: string]: any;
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

// v599b compat shim begin --------------------------------------------------
// Surface that matches Codex-generated route files. Pure additive / wider.
import { createRequire as __req_v599b } from "module";
import { publishToUser as __pub, publishToUsers as __pubMany, publishBroadcast as __pubAll } from "./sseBus.js";

const __require_v599b = __req_v599b(import.meta.url);
const __twilio_v599b = __require_v599b("twilio");

function __getTw() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error("twilio_not_configured");
  return __twilio_v599b(sid, tok);
}
function __baseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "https://server.boreal.financial";
}
function __callerId(): string {
  return process.env.TWILIO_CALLER_ID
    || process.env.TWILIO_DEFAULT_OUTBOUND_CALLER_ID
    || process.env.TWILIO_FROM_NUMBER
    || process.env.TWILIO_PHONE_NUMBER
    || "";
}

// ── Name aliases ──────────────────────────────────────────────────────────
export const getConferenceByFriendly = getConferenceByFriendlyName;
export const getConferenceById = getConference;
export const getParticipantBySid = findParticipantByCallSid;
export const setParticipantCallSid = attachCallSidToParticipant;

export async function getParticipantById(participantId: string): Promise<ParticipantRow | null> {
  const { pool } = await import("../db.js");
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT * FROM conference_participants WHERE id = $1`, [participantId]
  );
  return rows[0] ?? null;
}

// addParticipantRow returns the *id string* (Codex assigns the result to string).
// Keep addParticipant available for callers that want the full row.
export async function addParticipantRow(args: any): Promise<string> {
  const row = await addParticipant(args);
  return row.id;
}

// ── State notifications (variadic to tolerate Codex's extra args) ─────────
export async function notifyConferenceState(conferenceId: string, ..._extras: any[]): Promise<void> {
  void _extras;
  const c = await getConference(conferenceId);
  if (!c) return;
  const parts = await listParticipants(conferenceId);
  if (c.created_by_user_id) __pub(c.created_by_user_id, "conference.update", { conference: c, participants: parts });
  const staffIds = parts.filter(p => p.kind === "staff" && p.identity).map(p => p.identity as string);
  if (staffIds.length > 0) __pubMany(staffIds, "conference.update", { conference: c, participants: parts });
}

function __coerceConfId(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v.conference_id ?? v.id ?? "");
  return String(v);
}

export async function broadcastIncomingRing(conferenceIdOrRow: any, fromLabel?: string, ..._rest: any[]): Promise<void> {
  void _rest;
  const conferenceId = __coerceConfId(conferenceIdOrRow);
  if (!conferenceId) return;
  const parts = await listParticipants(conferenceId);
  const staffIds = parts.filter(p => p.kind === "staff" && p.identity).map(p => p.identity as string);
  // BF_SERVER_BLOCK_v839_INCOMING_CALLER_NUMBER — the client listens for
  // "conference.incoming" with { conferenceFriendly, fromDisplay }. Emit that
  // (carrying the real caller number) plus the legacy "incoming.call".
  const caller = fromLabel ?? "unknown";
  const legacy = { conferenceId, from: caller };
  const toast = { conferenceId, conferenceFriendly: conferenceId, fromDisplay: caller };
  if (staffIds.length === 0) {
    __pubAll("incoming.call", legacy);
    __pubAll("conference.incoming", toast);
  } else {
    __pubMany(staffIds, "incoming.call", legacy);
    __pubMany(staffIds, "conference.incoming", toast);
  }

  // BF_SERVER_INCOMING_CALL_PUSH_v1 - also fire a web push so staff get an OS-level notification
  // for an incoming call even when the portal is minimized or closed. Best-effort and after the
  // live ring so it never delays the ring. Pushes to everyone subscribed (shared inbound line).
  try {
    const { pushToUser } = await import("../services/notifications/pushToUser.js");
    const { listPwaSubscriptions } = await import("../repositories/pwa.repo.js");
    const subs = await listPwaSubscriptions();
    const userIds = Array.from(new Set(subs.map((sub) => sub.user_id).filter(Boolean)));
    const pushBody = caller && caller !== "unknown" ? ("Call from " + caller) : "Incoming call";
    await Promise.allSettled(
      userIds.map((uid) => pushToUser(uid as string, "Incoming call", pushBody, "/communications")),
    );
  } catch (e) {
    console.error("[incoming-call-push] failed", { error: String(e).slice(0, 200) });
  }
}

export async function broadcastIncomingAnswered(conferenceIdOrRow: any, ..._rest: any[]): Promise<void> {
  void _rest;
  const conferenceId = __coerceConfId(conferenceIdOrRow);
  if (!conferenceId) return;
  const parts = await listParticipants(conferenceId);
  const staffIds = parts.filter(p => p.kind === "staff" && p.identity).map(p => p.identity as string);
  __pubMany(staffIds, "incoming.answered", { conferenceId });
}

// ── Dial helpers ──────────────────────────────────────────────────────────
export interface DialIntoConferenceArgs {
  conferenceFriendlyName?: string;
  conferenceFriendly?: string;
  friendlyName?: string;
  conference?: string;
  conf?: string;
  conferenceId?: string;
  phoneNumber?: string | null;
  phone?: string | null;
  to?: string | null;
  toNumber?: string | null;
  fromNumber?: string | null;
  identity?: string | null;
  role?: "moderator" | "participant" | string;
  endOnExit?: boolean;
  [k: string]: any;
}

async function __resolveFriendly(a: DialIntoConferenceArgs): Promise<string> {
  if (a.conferenceFriendlyName) return String(a.conferenceFriendlyName);
  if (a.conferenceFriendly)     return String(a.conferenceFriendly);
  if (a.friendlyName)           return String(a.friendlyName);
  if (a.conference)             return String(a.conference);
  if (a.conf)                   return String(a.conf);
  if (a.conferenceId) {
    const c = await getConference(String(a.conferenceId));
    if (c?.friendly_name) return c.friendly_name;
  }
  return "";
}

export async function dialPstnIntoConference(args: DialIntoConferenceArgs): Promise<{ callSid: string }> {
  const friendly = await __resolveFriendly(args);
  const phone = String(args.phoneNumber ?? args.phone ?? args.to ?? args.toNumber ?? "");
  if (!friendly || !phone) throw new Error("dialPstnIntoConference: missing args");
  const tw = __getTw();
  const call = await tw.calls.create({
    to: phone, from: __callerId(),
    url: `${__baseUrl()}/api/webhooks/twilio/conference/join?conf=${encodeURIComponent(friendly)}&pid=${encodeURIComponent(String(args.participantId ?? ""))}`,
    method: "POST",
    statusCallback: `${__baseUrl()}/api/webhooks/twilio/voice/call-status`,
    statusCallbackEvent: ["initiated","ringing","answered","completed"],
    statusCallbackMethod: "POST",
  });
  return { callSid: call.sid };
}

export async function dialClientIntoConference(args: DialIntoConferenceArgs): Promise<{ callSid: string }> {
  const friendly = await __resolveFriendly(args);
  const identity = String(args.identity ?? "");
  if (!friendly || !identity) throw new Error("dialClientIntoConference: missing args");
  const tw = __getTw();
  const call = await tw.calls.create({
    // BF_SERVER_CALLER_NUMBER_DISPLAY_v1 — show the real caller number on the
    // staff dialer instead of our own Twilio number. fromNumber is the PSTN
    // caller; fall back to our caller ID when no real number is available.
    to: `client:${identity}`,
    from: (typeof args.fromNumber === "string" && args.fromNumber.trim() ? args.fromNumber : __callerId()),
    url: `${__baseUrl()}/api/webhooks/twilio/conference/join?conf=${encodeURIComponent(friendly)}&pid=${encodeURIComponent(String(args.participantId ?? ""))}`,
    method: "POST",
    statusCallback: `${__baseUrl()}/api/webhooks/twilio/voice/call-status`,
    statusCallbackEvent: ["initiated","ringing","answered","completed"],
    statusCallbackMethod: "POST",
    timeout: 15, // BF_SERVER_NO_ANSWER_15S — ring staff 15s, then caller -> voicemail
  });
  return { callSid: call.sid };
}

export async function cancelPendingParticipantCall(participantId: string): Promise<void> {
  const p = await getParticipantById(participantId);
  if (!p?.twilio_call_sid) return;
  if (["completed","canceled","left"].includes(p.status)) return;
  try {
    const tw = __getTw();
    await tw.calls(p.twilio_call_sid).update({ status: "canceled" });
  } catch { /* best-effort */ }
}
// v599b compat shim end ----------------------------------------------------
