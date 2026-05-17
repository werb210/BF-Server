// BF_SERVER_BLOCK_43_v1
// Twilio incoming-call webhook. Rings every staff member who is
// currently online (twilio_identity present in staff_presence and
// last_heartbeat in the last 5 minutes). If no one is online, falls
// back to the configured company phone number so the applicant
// always reaches a human.
import type { Request, Response } from "express";
import twilio from "twilio";
import { pool } from "../../db.js";
import { ok } from "../../lib/respond.js";

const VoiceResponse = twilio.twiml.VoiceResponse;

const FALLBACK_PHONE = process.env.TWILIO_FALLBACK_PHONE
  ?? process.env.OPS_PHONE_NUMBER
  ?? process.env.COMPANY_PHONE_NUMBER
  ?? "";

export async function incomingCallHandler(_req: Request, res: Response): Promise<Response> {
  const response = new VoiceResponse();

  // Query online staff. Last 5-minute window matches the staff
  // presence heartbeat in telephonyRoutes.ts.
  let identities: string[] = [];
  try {
    const r = await pool.query<{ twilio_identity: string | null }>(
      `SELECT twilio_identity FROM staff_presence
        WHERE last_heartbeat > now() - interval '5 minutes'
          AND status = 'available'
          AND twilio_identity IS NOT NULL
        ORDER BY last_heartbeat DESC
        LIMIT 10`,
    );
    identities = r.rows
      .map((row) => row.twilio_identity)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    console.warn("[incoming-call] presence lookup failed", err);
  }

  if (identities.length > 0) {
    // Ring all online staff in parallel; first to answer wins.
    // timeout=20s lets the call ring before falling back.
    const dial = response.dial({ timeout: 20, answerOnBridge: true });
    for (const identity of identities) {
      dial.client(identity);
    }
  } else if (FALLBACK_PHONE) {
    const dial = response.dial({ timeout: 25, answerOnBridge: true });
    // BF_SERVER_BLOCK_43_HOTFIX_v1 -- the repo's twilio shim
    // (src/types/twilio-shims.d.ts) only declares Dial.client(); the
    // real TwiML SDK supports .number() at runtime. Cast for now.
    (dial as any).number(FALLBACK_PHONE);
  } else {
    // BF_SERVER_BLOCK_43_HOTFIX_v1 -- shim's say() takes 1 arg.
    // Drop the voice-attributes object; Twilio default voice is fine.
    response.say(
      "Thanks for calling Boreal. Our team is currently unavailable. Please leave a message after the tone.",
    );
    response.record({
      maxLength: 120,
      playBeep: true,
      transcribe: false,
    });
  }

  return ok(res, response.toString());
}
