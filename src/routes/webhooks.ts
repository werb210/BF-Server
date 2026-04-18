import { Router } from "express";
import twilio from "twilio";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import MessagingResponse from "twilio/lib/twiml/MessagingResponse.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logWarn } from "../observability/logger.js";
import { handleVoiceStatusWebhook } from "../modules/voice/voice.service.js";
import { config } from "../config/index.js";
import { pool } from "../db.js";

const { validateRequest } = twilio;
const router = Router();

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://server.boreal.financial";

function twilioAuthToken(): string {
  const t = config.twilio.authToken;
  if (!t?.trim()) throw new AppError("twilio_misconfigured", "Twilio auth token missing.", 500);
  return t.trim();
}

function buildWebhookUrl(req: any, suffix = ""): string {
  const base = config.app.baseUrl?.trim();
  if (base) return `${base.replace(/\/$/, "")}/api/webhooks/twilio/voice${suffix}`;
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host}${req.originalUrl}`;
}

// ── Inbound TwiML — serve XML to ring all available staff simultaneously ─────
router.post("/twilio/voice/twiml", safeHandler(async (_req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const vr = new VoiceResponse();

  try {
    // Online staff = heartbeat within last 5 min and status = available
    const staffRes = await pool.query<{ twilio_identity: string }>(
      `SELECT twilio_identity FROM staff_presence
       WHERE status = 'available'
         AND last_heartbeat > now() - interval '5 minutes'
         AND twilio_identity IS NOT NULL
       ORDER BY last_heartbeat DESC
       LIMIT 10`
    );
    const identities = staffRes.rows.map((r) => r.twilio_identity);

    if (identities.length === 0) {
      // No staff online — go straight to voicemail
      vr.say({ voice: "Polly.Joanna" }, "No agents are available. Please leave a message after the tone.");
      vr.record({
        action: `${BASE_URL}/api/webhooks/twilio/voicemail`,
        method: "POST",
        maxLength: 120,
        transcribe: false,
        playBeep: true,
      });
    } else {
      const dial = vr.dial({
        timeout: 30,
        action: `${BASE_URL}/api/webhooks/twilio/voice/no-answer`,
        method: "POST",
      });
      for (const identity of identities) {
        dial.client(identity);
      }
    }
  } catch {
    vr.say({ voice: "Polly.Joanna" }, "We are experiencing technical difficulties. Please try again.");
  }

  res.send(vr.toString());
}));

// ── No-answer fallback — goes to voicemail ────────────────────────────────────
router.post("/twilio/voice/no-answer", safeHandler(async (_req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const vr = new VoiceResponse();
  vr.say({ voice: "Polly.Joanna" }, "Sorry, no agents are available right now. Please leave your name, number, and a brief message and we will call you back.");
  vr.record({
    action: `${BASE_URL}/api/webhooks/twilio/voicemail`,
    method: "POST",
    maxLength: 120,
    transcribe: false,
    playBeep: true,
  });
  res.send(vr.toString());
}));

// ── Voicemail recording ───────────────────────────────────────────────────────
router.post("/twilio/voicemail", safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const vr = new VoiceResponse();

  const { RecordingUrl, RecordingDuration, CallSid, From } = req.body ?? {};
  if (RecordingUrl && CallSid) {
    const fromNum = typeof From === "string" ? From : null;
    // Look up contact by phone
    const contact = fromNum
      ? await pool.query<{ id: string }>(
          `SELECT id FROM contacts WHERE phone = $1 OR mobile_phone = $1 LIMIT 1`,
          [fromNum]
        ).then((r) => r.rows[0] ?? null).catch(() => null)
      : null;

    await pool.query(
      `INSERT INTO voicemails (id, recording_url, recording_sid, duration, from_number, contact_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now())
       ON CONFLICT DO NOTHING`,
      [
        String(RecordingUrl),
        String(CallSid),
        parseInt(String(RecordingDuration ?? "0"), 10) || 0,
        fromNum,
        contact?.id ?? null,
      ]
    ).catch(() => {});
  }

  vr.say({ voice: "Polly.Joanna" }, "Thank you. We will be in touch shortly. Goodbye.");
  vr.hangup();
  res.send(vr.toString());
}));

// ── Voice status webhook ─────────────────────────────────────────────────────
router.post(
  "/twilio/voice",
  safeHandler(async (req: any, res: any) => {
    const signature = req.get("x-twilio-signature");
    if (!signature) {
      logWarn("voice_webhook_missing_signature", { path: req.originalUrl });
      throw new AppError("invalid_signature", "Missing Twilio signature.", 403);
    }
    const valid = validateRequest(twilioAuthToken(), signature, buildWebhookUrl(req), req.body ?? {});
    if (!valid) {
      logWarn("voice_webhook_signature_invalid", { path: req.originalUrl });
      throw new AppError("invalid_signature", "Invalid Twilio signature.", 403);
    }
    const payload = req.body ?? {};
    const callSid = typeof payload.CallSid === "string" ? payload.CallSid : null;
    if (callSid) {
      await handleVoiceStatusWebhook({
        callSid,
        callStatus: typeof payload.CallStatus === "string" ? payload.CallStatus : null,
        callDuration: payload.CallDuration ?? null,
        from: typeof payload.From === "string" ? payload.From : null,
        to: typeof payload.To === "string" ? payload.To : null,
        errorCode: payload.ErrorCode ? String(payload.ErrorCode) : null,
        errorMessage: typeof payload.ErrorMessage === "string" ? payload.ErrorMessage : null,
      });
    }
    res.status(200).json({ ok: true });
  })
);

async function persistInboundSms(req: any): Promise<void> {
  const { Body, From, To, MessageSid } = req.body ?? {};
  if (!(Body && From)) return;

  const fromNum = String(From);
  const toNum = typeof To === "string" ? To : null;
  const body = String(Body);
  const sid = typeof MessageSid === "string" ? MessageSid : null;

  // Look up contact by phone number
  const contact = await pool.query<{ id: string }>(
    `SELECT id FROM contacts WHERE phone = $1 OR mobile_phone = $1 LIMIT 1`,
    [fromNum]
  ).then((r) => r.rows[0] ?? null).catch(() => null);

  await pool.query(
    `INSERT INTO communications_messages
       (id, type, direction, status, body, phone_number, from_number, to_number, twilio_sid, contact_id, created_at)
     VALUES (gen_random_uuid(), 'sms', 'inbound', 'received', $1, $2, $2, $3, $4, $5, now())
     ON CONFLICT (twilio_sid) DO NOTHING`,
    [body, fromNum, toNum, sid, contact?.id ?? null]
  ).catch(() => {});
}

// ── Inbound SMS webhook ───────────────────────────────────────────────────────
router.post("/twilio/sms", safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const mr = new MessagingResponse();

  await persistInboundSms(req);

  // No auto-reply for now — staff replies manually from portal
  res.send(mr.toString());
}));

// Alias inbound SMS route for easier Twilio console config.
router.post("/inbound", safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const mr = new MessagingResponse();
  await persistInboundSms(req);
  res.send(mr.toString());
}));

// SignNow webhook (preserved)
router.post("/signnow", safeHandler(async (req: any, res: any) => {
  res.status(200).json({ ok: true, received: req.body });
}));

export default router;
