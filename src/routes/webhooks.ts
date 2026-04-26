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
import { eventBus } from "../events/eventBus.js";

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
router.post("/twilio/voice/twiml", safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const params = req.body ?? {};
  const to = String(params.To ?? params.to ?? "").trim();
  const outboundFlag = params.outbound === "1" || params.outbound === 1 || params.outbound === true;
  const looksLikePhone = /^\+?\d{10,15}$/.test(to);
  const callerId = process.env.TWILIO_CALLER_ID || process.env.TWILIO_NUMBER || "";

  const vr = new VoiceResponse();
  if ((looksLikePhone || outboundFlag) && to) {
    const dial = vr.dial({ callerId, answerOnBridge: true, timeout: 25 });
    dial.number(to);
  } else {
    vr.say({ voice: "Polly.Joanna" }, "Sorry, no agents are available right now. Please leave a message after the tone.");
    vr.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
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
  const contact = await pool.query<{ id: string; silo: string | null }>(
    `SELECT id, silo FROM contacts WHERE phone = $1 LIMIT 1`,
    [fromNum]
  ).then((r) => r.rows[0] ?? null).catch(() => null);

  await pool.query(
    `INSERT INTO messages
       (id, body, contact_id, direction, from_number, to_number, silo, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'inbound', $3, $4, $5, now())
     `,
    [body, contact?.id ?? null, fromNum, toNum, contact?.silo ?? "BF"]
  ).catch(() => {});

  eventBus.emit("sms.inbound.received", {
    contactId: contact?.id ?? null,
    from: fromNum,
    to: toNum,
    body,
    sid,
  });
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
