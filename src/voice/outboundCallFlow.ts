// BF_SERVER_v829_DIALER_RELIABILITY - outbound calls placed from the iPhone dialler (and the portal) as conferences.
//
// Before: POST /api/voice/calls dialled the customer at once, before the staff phone had even fetched its token. If
// the staff side failed or hung up while it rang, nothing cancelled the customer's leg (its CallSid was never saved),
// so they answered into silence. Staff heard nothing while it rang, and busy / no answer just sat "connected" in
// silence until they hung up.
//
// Now:
//   - dialOnJoin (the dialler sends it): the customer is dialled only when the staff leg joins the conference.
//   - the staff leg waits in the conference hearing a ringback tone until the customer joins.
//   - busy / no answer / failed: the staff leg hears why ("The line is busy.") and is hung up; the participant row
//     keeps the reason, which the dialler reads to show it.
import { pool } from "../db.js";
import { getPublicBaseUrl } from "./twilioClient.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type Twilio = { calls: (sid: string) => { update: (args: Record<string, unknown>) => Promise<unknown> } };

/** Participant status while the callee waits for the staff leg to join (dialOnJoin). */
export const PENDING_DIAL = "pending_dial";
/** Why a callee never joined; kept on the participant row (the dialler shows it). */
export const UNANSWERED_STATUSES = ["busy", "no-answer", "failed"] as const;

export function unansweredMessage(status: string): string {
  if (status === "busy") return "The line is busy.";
  if (status === "no-answer") return "There was no answer.";
  return "The call could not be completed.";
}

export const RINGBACK_TWIML_PATH = "/api/webhooks/twilio/conference/ringback";
export const RINGBACK_AUDIO_PATH = "/api/webhooks/twilio/conference/ringback.wav";

/** waitUrl TwiML for a staff leg waiting for the customer: the ringback tone, looped. */
export function ringbackTwiml(base = getPublicBaseUrl()): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play loop="0">${base}${RINGBACK_AUDIO_PATH}</Play></Response>`;
}

let ringbackWav: Buffer | null = null;
/** North American ringback: 440 Hz + 480 Hz, 2 s on, 4 s off. 8 kHz 16-bit mono WAV, built once. */
export function ringbackAudio(): Buffer {
  if (ringbackWav) return ringbackWav;
  const rate = 8000;
  const samples = rate * 6;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const on = t < 2;
    const v = on ? 0.18 * (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t)) : 0;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  ringbackWav = Buffer.concat([header, data]);
  return ringbackWav;
}

async function defaultTwilio(): Promise<Twilio> {
  const { getTwilioClient } = await import("./twilioClient.js");
  return getTwilioClient() as unknown as Twilio;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Tells every staff leg still in the conference why it is ending, then hangs it up. Never throws. */
export async function endStaffLegsWithMessage(conferenceId: string, message: string, deps: { db?: Q; twilio?: () => Promise<Twilio> } = {}): Promise<number> {
  const db = deps.db ?? pool;
  let ended = 0;
  try {
    const legs = await db.query(
      `SELECT twilio_call_sid FROM conference_participants
        WHERE conference_id = $1 AND kind = 'staff' AND twilio_call_sid IS NOT NULL
          AND status NOT IN ('left', 'canceled', 'busy', 'no-answer', 'failed')`,
      [conferenceId],
    );
    if (!legs.rows.length) return 0;
    const tw = await (deps.twilio ?? defaultTwilio)();
    const twiml = `<Response><Say voice="Polly.Joanna">${xmlEscape(message)}</Say><Hangup/></Response>`;
    for (const leg of legs.rows) {
      try {
        await tw.calls(String(leg.twilio_call_sid)).update({ twiml });
        ended += 1;
      } catch (err: any) {
        console.warn("[outbound] could not end staff leg", { conferenceId, callSid: leg.twilio_call_sid, message: err?.message });
      }
    }
  } catch (err: any) {
    console.warn("[outbound] end staff legs failed", { conferenceId, message: err?.message });
  }
  return ended;
}

/**
 * Dials callees that were waiting for the staff leg (dialOnJoin). Claims each row first (pending_dial -> invited), so
 * a repeated join callback cannot dial twice. A dial that fails marks the row failed and ends the staff leg with a
 * reason. Never throws.
 */
export async function dialPendingCallees(conferenceId: string, deps: {
  db?: Q;
  dialPstn?: (args: Record<string, unknown>) => Promise<{ callSid: string }>;
  callerId?: (userId: string | null) => Promise<string>;
  endStaff?: (conferenceId: string, message: string) => Promise<unknown>;
} = {}): Promise<number> {
  const db = deps.db ?? pool;
  let dialled = 0;
  try {
    const claimed = await db.query(
      `UPDATE conference_participants p SET status = 'invited'
         FROM conferences c
        WHERE p.conference_id = $1 AND c.id = p.conference_id AND p.status = '${PENDING_DIAL}' AND p.kind = 'pstn'
        RETURNING p.id::text AS id, p.phone_number, c.friendly_name, c.created_by_user_id::text AS created_by_user_id`,
      [conferenceId],
    );
    for (const row of claimed.rows) {
      try {
        const callerId = deps.callerId
          ? await deps.callerId(row.created_by_user_id ?? null)
          : await (await import("./directLines.js")).callerIdForUser(pool, row.created_by_user_id ?? "");
        const dial = deps.dialPstn ?? (await import("./conferenceService.js")).dialPstnIntoConference;
        await dial({ conferenceId, conferenceFriendly: row.friendly_name, toNumber: row.phone_number, fromNumber: callerId, participantId: row.id });
        dialled += 1;
      } catch (err: any) {
        console.warn("[outbound] dialling the customer failed", { conferenceId, participantId: row.id, message: err?.message });
        await db.query(`UPDATE conference_participants SET status = 'failed', left_at = now() WHERE id = $1`, [row.id])
          .catch((e: any) => console.warn("[outbound] could not mark the leg failed", { participantId: row.id, message: e?.message }));
        await (deps.endStaff ?? endStaffLegsWithMessage)(conferenceId, unansweredMessage("failed"));
      }
    }
  } catch (err: any) {
    console.warn("[outbound] pending dial failed", { conferenceId, message: err?.message });
  }
  return dialled;
}

/**
 * A callee leg ended. When it never joined (busy / no-answer / failed) and nobody else is on the call with staff, keep
 * the reason on its row and end the staff leg with that reason. Returns the reason handled, or null. Never throws.
 */
export async function handleUnansweredCallee(part: { id: string; conference_id: string; kind: string; role: string; joined_at: string | null }, callStatus: string, deps: { db?: Q; endStaff?: (conferenceId: string, message: string) => Promise<unknown> } = {}): Promise<string | null> {
  const status = String(callStatus || "").toLowerCase();
  if (!(UNANSWERED_STATUSES as readonly string[]).includes(status)) return null;
  if (part.joined_at || part.role === "moderator") return null;
  const db = deps.db ?? pool;
  try {
    const conf = await db.query(`SELECT direction FROM conferences WHERE id = $1`, [part.conference_id]);
    const direction = String(conf.rows[0]?.direction ?? "");
    if (direction !== "outbound" && direction !== "internal") return null;
    await db.query(`UPDATE conference_participants SET status = $2, left_at = now() WHERE id = $1`, [part.id, status]);
    // Someone added to a call already in progress who doesn't answer must not end that call.
    const others = await db.query(
      `SELECT COUNT(*)::int AS c FROM conference_participants
        WHERE conference_id = $1 AND id <> $2 AND role <> 'moderator' AND status = 'joined'`,
      [part.conference_id, part.id],
    );
    if ((others.rows[0]?.c ?? 0) > 0) return status;
    await (deps.endStaff ?? endStaffLegsWithMessage)(part.conference_id, unansweredMessage(status));
    return status;
  } catch (err: any) {
    console.warn("[outbound] unanswered callee handling failed", { participantId: part.id, message: err?.message });
    return null;
  }
}
