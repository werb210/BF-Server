import { Router } from "express";
import express from "express";
import twilio from "twilio";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";
import MessagingResponse from "twilio/lib/twiml/MessagingResponse.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { handleVoiceStatusWebhook } from "../modules/voice/voice.service.js";
import { pool } from "../db.js";
import { eventBus } from "../events/eventBus.js";
// BF_SERVER_BLOCK_v305_TWILIO_WEBHOOK_SIGNATURES_v1 — reuse the canonical
// signature validation middleware (with full diag logging, see
// src/middleware/twilioWebhookValidation.ts) on every Twilio webhook
// instead of an inline ad-hoc check.
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";

void twilio;
const router = Router();

// BF_SERVER_BLOCK_v324_TWILIO_WEBHOOKS_URLENCODED_BODY_v1
// Twilio webhooks POST application/x-www-form-urlencoded data. app.ts only
// applies express.json() globally, NOT express.urlencoded(). Pre-fix every
// handler in this router received req.body = undefined (then defaulted to
// {}), with two compounding effects:
//   1. /twilio/voice/twiml: params.To was undefined, the looksLikePhone /
//      outboundFlag checks failed, and inbound calls ALL fell through to
//      the "Sorry, no agents available, please leave a message" voicemail
//      prompt instead of bridging to staff -- the user-reported symptom
//      "Twilio calling features are broken."
//   2. After v305 (signature validation), validateRequest hashes the URL
//      plus the form-encoded body params. With req.body = {} but Twilio's
//      signature computed over the actual params, every webhook 403'd
//      "invalid_signature." Even Twilio retries (5x over ~24h) fail
//      identically; the call log / SMS rows never get written.
// The fix is router-level express.urlencoded BEFORE the per-route
// twilioWebhookValidation middleware. extended:false matches Twilio's
// flat key=value body shape and matches the working voiceStatus.ts /
// twilioVoice.ts pattern (both apply the same parser per-route). express
// is now imported alongside Router for this purpose.
router.use(express.urlencoded({ extended: false }));

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://server.boreal.financial";

// BF_SERVER_BLOCK_v305_TWILIO_WEBHOOK_SIGNATURES_v1
// Five of six Twilio webhooks previously accepted unauthenticated POSTs:
//   /twilio/voice/twiml      — built TwiML that bridged a call to a body-
//                              supplied `to` number (toll-fraud vector).
//   /twilio/voice/no-answer  — built TwiML response (lower-impact spam).
//   /twilio/voicemail        — INSERTed attacker-supplied RecordingUrl,
//                              CallSid, duration, From number into
//                              voicemails (data injection / DB junk).
//   /twilio/sms              — INSERTed attacker-supplied SMS body and
//                              From into messages (spoofed-from injection).
//   /inbound (sms alias)     — same as /twilio/sms.
// Only POST /twilio/voice (status webhook) verified x-twilio-signature.
// This block adds the canonical twilioWebhookValidation middleware to
// every webhook handler in this router so all six fail-closed on a
// missing/invalid signature. Twilio's validateRequest already does a
// timing-safe compare internally, so no separate HMAC is needed.

// ── Inbound TwiML — serve XML to ring all available staff simultaneously ─────
// BF_SERVER_BLOCK_BI_ROUND5_7BIS_v1 -- Voice SDK outbound calls now
// create a call_logs row on the way through this webhook so the
// downstream status callback finds it to update. Pre-fix, SDK calls
// were never logged; only REST-path outbound calls (/api/telephony/
// outbound-call) made it into call_logs.
router.post("/twilio/voice/twiml", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const params = req.body ?? {};
  const to = String(params.To ?? params.to ?? "").trim();
  const outboundFlag = params.outbound === "1" || params.outbound === 1 || params.outbound === true;
  const looksLikePhone = /^\+?\d{10,15}$/.test(to);
  const callerId = process.env.TWILIO_CALLER_ID || process.env.TWILIO_NUMBER || "";

  // BF_SERVER_BLOCK_BI_ROUND5_7BIS_v1 -- create the call_logs row on
  // the way through, but only for SDK-initiated outbound calls. The
  // "client:" prefix on params.From is Twilio's convention for an
  // SDK-originated call; the suffix is the JWT user.userId we baked
  // into the access token at /api/telephony/token, which lets us
  // reuse it as staff_user_id without an extra lookup. Everything is
  // wrapped to fail-open: a DB hiccup must not break the call.
  const rawFrom = String(params.From ?? params.from ?? "").trim();
  const isSdkOutbound = rawFrom.startsWith("client:") && looksLikePhone && to;
  if (isSdkOutbound) {
    const callSid = String(params.CallSid ?? params.callSid ?? "").trim() || null;
    const identity = rawFrom.slice("client:".length).trim() || null;
    const siloParam = String(params.silo ?? params.Silo ?? "").trim().toUpperCase() || "BF";
    const applicationIdParam = (() => {
      const v = String(params.applicationId ?? params.applicationid ?? "").trim();
      return v.length > 0 ? v : null;
    })();
    try {
      const { startCall } = await import("../modules/calls/calls.service.js");
      await startCall({
        phoneNumber: to,
        fromNumber: callerId || null,
        toNumber: to,
        direction: "outbound",
        status: "initiated",
        staffUserId: identity,
        twilioCallSid: callSid,
        applicationId: applicationIdParam,
        silo: siloParam,
      });
    } catch (err: any) {
      // Non-fatal; the call still proceeds. The downstream status
      // webhook will surface voice_webhook_call_not_found if the
      // row really did fail to land, which is the existing observable.
      // eslint-disable-next-line no-console
      console.warn("voice_twiml_call_log_create_failed", {
        callSid,
        identity,
        silo: siloParam,
        applicationId: applicationIdParam,
        message: err?.message,
        code: err?.code,
      });
    }
  }

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
router.post("/twilio/voice/no-answer", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
  void req;
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
router.post("/twilio/voicemail", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
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
  twilioWebhookValidation,
  safeHandler(async (req: any, res: any) => {
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
router.post("/twilio/sms", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const mr = new MessagingResponse();

  await persistInboundSms(req);

  // No auto-reply for now — staff replies manually from portal
  res.send(mr.toString());
}));

// Alias inbound SMS route for easier Twilio console config.
router.post("/inbound", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const mr = new MessagingResponse();
  await persistInboundSms(req);
  res.send(mr.toString());
}));

// SignNow webhook (preserved)
// BF_SERVER_BLOCK_v141_SIGNNOW_WEBHOOK_REPAIR_v1 — removed the no-op
// /signnow echo. The real handler is in routes/signnow.ts and is
// mounted via rootRoutes; this echo was first-match-wins shadowing
// it because /webhooks mounts before rootRoutes in routeRegistry.
export default router;
