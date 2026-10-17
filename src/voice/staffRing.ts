// BF_SERVER_v821_DIALER - ringing one staff member: shared by the direct-line webhook (routes/webhooks.ts) and the
// receptionist (routes/reception.ts). Adds, on top of the v820 "app first, then the screened cell" ring:
//   - the caller card as <Client> custom parameters (callerName / callerCompany / callerStage / contactId)
//   - recording of the bridged call (recordedDial.ts) so it reaches the AI summary pipeline
//   - do-not-disturb by hours (callHours.ts): "{Name} is away right now..." with press-1 passthrough
import { getPublicBaseUrl } from "./twilioClient.js";
import { CLIENT_FIRST_TIMEOUT_SECONDS, verifiedWatchCell } from "./watchCellFallback.js";
import { callerCardForCall, dialClient, type CallerCard } from "./callerCard.js";
import {
  RECORDING_NOTICE, inboundRecordName, legStatusAttrs, openCallRecord, recordingDialAttrs,
} from "./recordedDial.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export const RECEPTION_BASE = "/api/webhooks/twilio/reception";
export const AWAY_GATHER_TIMEOUT_SECONDS = 6;
const VOICE = "Polly.Joanna";

export function awayPromptText(name: string): string {
  return `${name} is away right now. To leave a voicemail, stay on the line. If this is urgent, press 1.`;
}

/** Opens the inbound call record for a call that is about to ring staff (null when it cannot / should not be recorded). */
export async function openInboundRecord(q: Q, args: { callSid: string | null | undefined; from: string | null | undefined; card: CallerCard | null; silo?: string }): Promise<string | null> {
  const callSid = String(args.callSid ?? "").trim();
  if (!callSid) return null;
  return openCallRecord(q, {
    friendlyName: inboundRecordName(callSid),
    direction: "inbound",
    silo: args.silo ?? "BF",
    contactId: args.card?.contactId ?? null,
    participants: [{ kind: "pstn", phone: String(args.from ?? "").trim() || null, callSid }],
  });
}

/** A staff member's voicemail: prompt + <Record> stamped with their id (private to them). */
export function staffVoicemail(v: any, userId: string | null, prompt = "Please leave your name, number, and a brief message after the tone."): void {
  v.say({ voice: VOICE }, prompt);
  const action = userId ? `/api/webhooks/twilio/voicemail?staff=${encodeURIComponent(userId)}` : "/api/webhooks/twilio/voicemail";
  v.record({ maxLength: 120, playBeep: true, action });
}

/**
 * Outside call hours. urgentPassthrough: "{Name} is away right now... press 1" <Gather numDigits=1 timeout=6>, then
 * (no key) their voicemail; 1 -> ringUrl. Without passthrough: straight to their voicemail.
 */
export function awayTwiml(v: any, args: { name: string; userId: string; urgentPassthrough: boolean; ring: "direct" | "sales" | "underwriting" }): void {
  if (!args.urgentPassthrough) {
    v.say({ voice: VOICE }, `${args.name} is away right now.`);
    staffVoicemail(v, args.userId);
    return;
  }
  const action = `${RECEPTION_BASE}/away-choice?user=${encodeURIComponent(args.userId)}&ring=${args.ring}`;
  const g = v.gather({ input: "dtmf", numDigits: 1, timeout: AWAY_GATHER_TIMEOUT_SECONDS, action, method: "POST" });
  g.say({ voice: VOICE }, awayPromptText(args.name));
  staffVoicemail(v, args.userId);
}

/**
 * Rings a direct-line owner: their app (with the caller card), then - if they opted in to the standalone Watch
 * fallback - direct-unavailable?cell=1 tries their verified cell, screened. The bridged call is recorded.
 */
export async function ringDirectLine(v: any, q: Q, args: {
  owner: { userId: string; identity: string };
  from: string;
  callSid: string | null | undefined;
}): Promise<{ watchCell: boolean; recorded: boolean }> {
  const watchCell = await verifiedWatchCell(q, args.owner.userId);
  const card = await callerCardForCall(q, args.from);
  const rec = await openInboundRecord(q, { callSid: args.callSid, from: args.from, card });
  // Canada is two-party consent: the caller hears the notice before anyone can answer a recorded call.
  if (rec) v.say({ voice: VOICE }, RECORDING_NOTICE);
  const dlAction = `${getPublicBaseUrl()}${RECEPTION_BASE}/direct-unavailable?user=${encodeURIComponent(args.owner.userId)}${watchCell ? "&cell=1" : ""}`;
  const dial = v.dial({
    answerOnBridge: true, timeout: watchCell ? CLIENT_FIRST_TIMEOUT_SECONDS : 25, callerId: args.from, action: dlAction, method: "POST",
    ...recordingDialAttrs(rec),
  } as any);
  dialClient(dial, args.owner.identity, card, legStatusAttrs(rec, args.owner.identity));
  return { watchCell: Boolean(watchCell), recorded: Boolean(rec) };
}
