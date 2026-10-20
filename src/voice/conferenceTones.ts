// BF_SERVER_v830_DIALER_CONTROLS - keypad tones to a participant in a conference call (see voiceMidCall.ts /dtmf).
import { getPublicBaseUrl } from "./twilioClient.js";

type Tw = { conferences: (sid: string) => { participants: (callSid: string) => { update: (args: Record<string, unknown>) => Promise<unknown> } } };

export const TONES_PATH = "/api/webhooks/twilio/conference/tones";

/** 0-9, *, # and w (a half-second pause); up to 32. */
export function validTones(digits: string): boolean {
  return /^[0-9*#w]{1,32}$/.test(digits);
}

/** The announcement TwiML: the tones, played into that participant's leg. */
export function tonesTwiml(digits: string): string {
  const safe = validTones(digits) ? digits : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${safe ? `<Play digits="${safe}"/>` : ""}</Response>`;
}

export async function sendTonesToParticipant(tw: Tw, conferenceSid: string, callSid: string, digits: string, base = getPublicBaseUrl()): Promise<void> {
  await tw.conferences(conferenceSid).participants(callSid).update({
    announceUrl: `${base}${TONES_PATH}?d=${encodeURIComponent(digits)}`,
    announceMethod: "POST",
  });
}
