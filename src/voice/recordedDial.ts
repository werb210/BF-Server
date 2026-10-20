// BF_SERVER_v821_DIALER - recording for calls that never enter a conference.
//
// Portal and app calls that go through a conference (/api/voice/calls outbound, ring-all inbound, client app "Call
// us") are recorded by <Conference record>, and the recording -> Voice Intelligence transcript -> AI summary ->
// timeline note + follow-up suggestions pipeline keys everything on a conferences row
// (/api/webhooks/twilio/recording/status?conf=<friendly_name>).
//
// Three iOS-dialler paths bridge with a plain <Dial> instead and were therefore never recorded, transcribed or
// summarised:
//   1. reception + direct-line inbound calls answered in the app (or on the screened cell): <Dial><Client>/<Number>
//   2. Watch callback bridges: the staff cell is called, then <Dial><Number> to the client
//   3. a staff app call placed with a bare To (no conferenceFriendly): <Dial><Number>
// For those this module opens a "call record" conferences row (direction inbound/outbound, never status 'joined'
// participants, so presence's on_call sync ignores it), records the <Dial> dual-channel from answer, and points the
// recording callback at the same /recording/status handler. Everything downstream is unchanged and shared.
//
// Consent rules are the conference ones: recording is on unless ENABLE_CALL_RECORDING="false", and every outside
// party hears "This call may be recorded..." before they are connected.
import { getPublicBaseUrl } from "./twilioClient.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const RECORDING_NOTICE = "This call may be recorded for quality and training purposes.";
export const LEG_STATUS_PATH = "/api/webhooks/twilio/reception/leg-status";
export const CONSENT_PATH = "/api/webhooks/twilio/reception/recording-notice";

export function callRecordingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ENABLE_CALL_RECORDING !== "false";
}

/** Deterministic call-record names, so an action callback can find the row from the parent CallSid alone. */
export const inboundRecordName = (parentCallSid: string) => `rx_${parentCallSid}`;
export const bridgeRecordName = (bridgeId: string) => `wb_${bridgeId}`;
export const outboundRecordName = (callSid: string) => `ob_${callSid}`;

export type CallRecordParticipant = {
  kind: "staff" | "pstn" | "client_miniportal";
  identity?: string | null;
  phone?: string | null;
  callSid?: string | null;
};

/**
 * Creates (once) the conferences row a <Dial> recording is filed under. Returns the friendly name to put in the
 * recording callback, or null when recording is off or the row could not be written (the call still rings; it is
 * just not recorded - logged, never thrown).
 */
export async function openCallRecord(q: Q, args: {
  friendlyName: string;
  direction: "inbound" | "outbound";
  silo?: string | null;
  contactId?: string | null;
  createdByUserId?: string | null;
  participants?: CallRecordParticipant[];
}): Promise<string | null> {
  if (!callRecordingEnabled() || !args.friendlyName) return null;
  try {
    const { rows } = await q.query(
      `WITH existing AS (SELECT id FROM conferences WHERE friendly_name = $1 ORDER BY created_at DESC LIMIT 1),
            ins AS (
              INSERT INTO conferences (friendly_name, silo, created_by_user_id, contact_id, direction, status, started_at)
              SELECT $1, $2, $3, $4, $5, 'ringing', now()
               WHERE NOT EXISTS (SELECT 1 FROM existing)
              RETURNING id
            )
       SELECT id::text AS id, true AS created FROM ins
       UNION ALL
       SELECT id::text AS id, false AS created FROM existing`,
      [args.friendlyName, args.silo || "BF", args.createdByUserId ?? null, args.contactId ?? null, args.direction],
    );
    const row = rows[0];
    if (!row?.id) return null;
    if (row.created) {
      for (const p of args.participants ?? []) {
        await q.query(
          `INSERT INTO conference_participants (conference_id, identity, phone_number, kind, role, status, twilio_call_sid)
           VALUES ($1::uuid, $2, $3, $4, 'participant', 'connected', $5)`,
          [row.id, p.identity ?? null, p.phone ?? null, p.kind, p.callSid ?? null],
        );
      }
    }
    return args.friendlyName;
  } catch (err: any) {
    console.warn("[call_record] open failed; dialling without recording", { friendlyName: args.friendlyName, message: err?.message });
    return null;
  }
}

/** Marks the call record ended (idempotent). */
export async function closeCallRecord(q: Q, friendlyName: string): Promise<void> {
  try {
    await q.query(
      `UPDATE conferences SET status = 'ended', ended_at = COALESCE(ended_at, now()), updated_at = now()
        WHERE friendly_name = $1 AND COALESCE(status, '') <> 'ended'`,
      [friendlyName],
    );
  } catch (err: any) {
    console.warn("[call_record] close failed", { friendlyName, message: err?.message });
  }
}

/** <Dial> attributes: dual-channel recording from answer, filed under the call record. */
export function recordingDialAttrs(friendlyName: string | null): Record<string, unknown> {
  if (!friendlyName) return {};
  return {
    record: "record-from-answer-dual",
    recordingStatusCallback: `${getPublicBaseUrl()}/api/webhooks/twilio/recording/status?conf=${encodeURIComponent(friendlyName)}`,
    recordingStatusCallbackEvent: "in-progress completed absent",
    recordingStatusCallbackMethod: "POST",
  };
}

/**
 * <Client>/<Number> status callback for a staff leg: when it is answered, that staff member becomes a participant
 * of the call record under the leg's own CallSid (the CallSid the iPhone app / CallKit holds).
 */
export function legStatusAttrs(friendlyName: string | null, identity: string | null | undefined): Record<string, unknown> {
  if (!friendlyName || !identity) return {};
  return {
    statusCallback: `${getPublicBaseUrl()}${LEG_STATUS_PATH}?conf=${encodeURIComponent(friendlyName)}&identity=${encodeURIComponent(identity)}`,
    statusCallbackEvent: "answered completed",
    statusCallbackMethod: "POST",
  };
}

/** <Number url> that tells the called party about recording before they are connected. */
export function consentUrl(): string {
  return `${getPublicBaseUrl()}${CONSENT_PATH}`;
}

/** Twilio leg status callback -> participant row (answered) / call record ended (completed). Never throws. */
export async function recordLegStatus(q: Q, args: { friendlyName: string; identity: string; callSid: string; status: string; parentCallSid?: string | null }): Promise<void> {
  const status = String(args.status || "").toLowerCase();
  try {
    if (status === "in-progress" || status === "answered") {
      await q.query(
        `INSERT INTO conference_participants (conference_id, identity, kind, role, status, twilio_call_sid, joined_at)
         SELECT c.id, $2, 'staff', 'participant', 'answered', $3, now()
           FROM conferences c
          WHERE c.friendly_name = $1
            AND NOT EXISTS (SELECT 1 FROM conference_participants p WHERE p.twilio_call_sid = $3)
          ORDER BY c.created_at DESC LIMIT 1`,
        [args.friendlyName, args.identity, args.callSid],
      );
      await q.query(
        `UPDATE conferences SET status = 'answered', updated_at = now() WHERE friendly_name = $1 AND status = 'ringing'`,
        [args.friendlyName],
      );
      // BF_SERVER_v829_DIALER_RELIABILITY - the inbound call_logs row (caller's sid) gets who answered and this leg's
      // sid, so the dialler can save the call outcome.
      const { claimInboundCall, parentSidFromRecordName } = await import("../modules/calls/callAttribution.js");
      await claimInboundCall(q, {
        parentCallSid: args.parentCallSid || parentSidFromRecordName(args.friendlyName),
        answeredLegSid: args.callSid,
        identity: args.identity,
      });
    } else if (status === "completed") {
      await q.query(
        `UPDATE conference_participants SET status = 'left', left_at = now() WHERE twilio_call_sid = $1 AND status <> 'left'`,
        [args.callSid],
      );
      // Only an answered leg ending ends the call; a ringing leg cancelled by another member's answer does not.
      const answered = await q.query(`SELECT 1 FROM conference_participants WHERE twilio_call_sid = $1 LIMIT 1`, [args.callSid]);
      if (answered.rows.length) await closeCallRecord(q, args.friendlyName);
    }
  } catch (err: any) {
    console.warn("[call_record] leg status failed", { friendlyName: args.friendlyName, status, message: err?.message });
  }
}
