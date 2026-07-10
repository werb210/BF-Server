import { Router } from "express";
import { bumpBiOutreachToEngagedByPhone } from "../services/biOutreach.js"; // BF_SERVER_BLOCK_v345_BI_OUTREACH_ENGAGED_v1
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
import { findCallLogByTwilioSid } from "../modules/calls/calls.repo.js"; // BF_SERVER_VOICEMAIL_PER_STAFF_v1

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
// BF_SERVER_BLOCK_v503_INBOUND_RING_ALL_v1
// Inbound (PSTN + mini-portal) now joins a freshly-created conference,
// then ring-alls available staff into the same conference. First answer
// wins; outstanding legs are auto-canceled on the conference's
// participant-join event in conferenceWebhooks. Voicemail fallback
// preserved for the no-staff case.

// BF_SERVER_BLOCK_BI_ROUND5_7BIS_v1 -- Voice SDK outbound calls now
// create a call_logs row on the way through this webhook so the
// downstream status callback finds it to update. Pre-fix, SDK calls
// were never logged; only REST-path outbound calls (/api/telephony/
// outbound-call) made it into call_logs.
router.post("/twilio/voice/twiml", twilioWebhookValidation, safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "text/xml");
  const params = req.body ?? {};
  const to = String(params.To ?? params.to ?? "").trim();
  const from = String(params.From ?? params.from ?? "").trim();
  const callSid = String(params.CallSid ?? params.callSid ?? "").trim();

  // ── v503: SDK-initiated outbound from staff browser (params.conferenceFriendly)
  // joins existing conference instead of doing legacy Dial-Number.
  const sdkConfFriendly = String(params.conferenceFriendly ?? "").trim();

  // BF_SERVER_BLOCK_v655_PIPELINE_AND_DIALER_v1
  // Single entry log so we can correlate every Twilio TwiML POST with
  // a call SID. Without this, when a dial fails at the DTLS layer the
  // BF-Server log shows nothing and we have to guess which branch ran.
  console.log(JSON.stringify({
    event: "voice_twiml_request",
    callSid: callSid || null,
    from: from || null,
    to: to || null,
    conferenceFriendly: sdkConfFriendly || null,
  }));

  if (sdkConfFriendly) {
    const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
    const { pool } = await import("../db.js");
    const { getConferenceByFriendly, addParticipantRow, setParticipantCallSid } = await import("../voice/conferenceService.js");
    const { getPublicBaseUrl } = await import("../voice/twilioClient.js");

    // BF_SERVER_BLOCK_v655_PIPELINE_AND_DIALER_v1
    // Retry the conference lookup once with a 250ms back-off. The conf
    // row was just INSERTed by /api/voice/calls; Twilio's TwiML POST
    // arrives ~100-200ms later, occasionally before pool/replica
    // visibility. Pre-v655 a single miss fell through to the legacy
    // stranger-call branch, which returns voicemail TwiML and trips
    // "Disconnecting… DTLS closed" on the browser.
    let conf = await getConferenceByFriendly(sdkConfFriendly);
    if (!conf) {
      await new Promise((r) => setTimeout(r, 250));
      conf = await getConferenceByFriendly(sdkConfFriendly);
    }

    if (conf) {
      const identity = from.startsWith("client:") ? from.slice("client:".length) : "";
      // Find existing caller participant row (created by /api/voice/calls) or create one.
      const r = await pool.query(
        `SELECT id FROM conference_participants
          WHERE conference_id = $1 AND identity = $2 AND status IN ('invited','ringing')
          ORDER BY created_at DESC LIMIT 1`,
        [conf.id, identity],
      );
      let pid: string;
      if (r.rows[0]?.id) {
        pid = r.rows[0].id;
        if (callSid) await setParticipantCallSid(pid, callSid);
      } else {
        pid = await addParticipantRow({
          conferenceId: conf.id, kind: "staff", identity,
          role: "moderator", displayName: identity,
        });
        if (callSid) await setParticipantCallSid(pid, callSid);
      }
      const base = getPublicBaseUrl();
      const vrs = new VoiceResponse();
      console.log(JSON.stringify({
        event: "voice_twiml_redirect_to_conference_join",
        callSid: callSid || null,
        conferenceFriendly: sdkConfFriendly,
        conferenceId: conf.id,
        participantId: pid,
      }));
      vrs.redirect({ method: "POST" }, `${base}/api/webhooks/twilio/conference/join?conf=${encodeURIComponent(sdkConfFriendly)}&pid=${encodeURIComponent(pid)}`);
      return res.send(vrs.toString());
    }

    // BF_SERVER_BLOCK_v655_PIPELINE_AND_DIALER_v1
    // conferenceFriendly was provided but the conference was not found
    // even after the retry. Do NOT fall through to the legacy
    // stranger-call branch — that branch returns voicemail TwiML
    // (Say + Record) which presents to the browser as
    // "Disconnecting… DTLS closed" with no accept event. Instead,
    // return a loud Say + Hangup so the operator hears a concrete
    // error and we get a single grep-able log line.
    console.log(JSON.stringify({
      event: "voice_twiml_conference_not_found_after_retry",
      callSid: callSid || null,
      conferenceFriendly: sdkConfFriendly,
    }));
    const vrErr = new VoiceResponse();
    vrErr.say(
      { voice: "Polly.Joanna" },
      "We could not reach the conference for this call. Please hang up and try again.",
    );
    vrErr.hangup();
    return res.send(vrErr.toString());
  }

  // ── v503: mini-portal inbound (client:client-*) -> conference + ring-all
  if (from.startsWith("client:client-")) {
    const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
    const { pool } = await import("../db.js");
    const { createConference, addParticipantRow, setParticipantCallSid, dialClientIntoConference, broadcastIncomingRing } = await import("../voice/conferenceService.js");
    const { getPublicBaseUrl } = await import("../voice/twilioClient.js");
    const available = await pool.query<{ user_id: string; twilio_identity: string }>(
      `SELECT user_id, twilio_identity FROM staff_presence
        WHERE status = 'available'
          AND last_heartbeat > now() - interval '5 minutes'
          AND twilio_identity IS NOT NULL`,
    ).catch(() => ({ rows: [] as any[] }));
    const vrc = new VoiceResponse();
    if (available.rows.length === 0) {
      vrc.say({ voice: "Polly.Joanna" }, "No agents are available right now. Please leave a message after the tone.");
      vrc.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
      return res.send(vrc.toString());
    }
    const conf = await createConference({
      silo: "BF", direction: "client_miniportal", createdByUserId: null,
      friendlyName: `mp_${callSid.slice(-12)}_${Date.now()}`,
    });
    const callerPid = await addParticipantRow({
      conferenceId: conf.id, kind: "client_miniportal",
      identity: from.slice("client:".length), displayName: "Client mini-portal",
    });
    if (callSid) await setParticipantCallSid(callerPid, callSid);
    // Ring all staff in parallel.
    const staffIds: string[] = [];
    await Promise.all(available.rows.map(async (row) => {
      const pid = await addParticipantRow({
        conferenceId: conf.id, kind: "staff",
        identity: row.twilio_identity, displayName: row.twilio_identity,
      });
      staffIds.push(String(row.user_id));
      try {
        await dialClientIntoConference({
          conferenceFriendly: conf.friendly_name,
          identity: row.twilio_identity, participantId: pid,
        });
      } catch (e: any) { console.warn("ring_all_dial_failed", { identity: row.twilio_identity, message: e?.message }); }
    }));
    void broadcastIncomingRing(staffIds, conf.friendly_name, "Client mini-portal");
    const base = getPublicBaseUrl();
    vrc.redirect({ method: "POST" }, `${base}/api/webhooks/twilio/conference/join?conf=${encodeURIComponent(conf.friendly_name)}&pid=${encodeURIComponent(callerPid)}`);
    return res.send(vrc.toString());
  }

  // ── v503: PSTN inbound -> conference + ring-all staff
  const looksLikePhoneFrom = /^\+?\d{8,15}$/.test(from);
  if (looksLikePhoneFrom && !from.startsWith("client:")) {
    // BF_SERVER_INBOUND_CALL_LOG_v1 — record every inbound PSTN call up front so
    // the later /twilio/voice status callback can find it. Without this the
    // callback logs voice_webhook_call_not_found and the call never lands in
    // call history (true for both the reception IVR and ring-all paths below).
    try {
      const { startCall } = await import("../modules/calls/calls.service.js");
      await startCall({
        phoneNumber: from,
        fromNumber: from,
        toNumber: to || null,
        direction: "inbound",
        status: "initiated",
        staffUserId: null,
        twilioCallSid: callSid || null,
        silo: "BF",
      });
    } catch (err: any) {
      console.warn("inbound_call_log_create_failed", { callSid, message: err?.message });
    }
    const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
    // BF_SERVER_RECEPTION_v1 — when enabled, hand PSTN callers to the Maya
    // receptionist instead of ring-all. Inert unless RECEPTION_ENABLED=true.
    if (process.env.RECEPTION_ENABLED === "true") {
      const vredir = new VoiceResponse();
      vredir.redirect({ method: "POST" }, "/api/webhooks/twilio/reception/greeting");
      return res.send(vredir.toString());
    }
    const { pool } = await import("../db.js");
    const { createConference, addParticipantRow, setParticipantCallSid, dialClientIntoConference, broadcastIncomingRing } = await import("../voice/conferenceService.js");
    const { getPublicBaseUrl } = await import("../voice/twilioClient.js");
    const available = await pool.query<{ user_id: string; twilio_identity: string }>(
      `SELECT user_id, twilio_identity FROM staff_presence
        WHERE status = 'available'
          AND last_heartbeat > now() - interval '5 minutes'
          AND twilio_identity IS NOT NULL`,
    ).catch(() => ({ rows: [] as any[] }));
    const vrp = new VoiceResponse();
    if (available.rows.length === 0) {
      vrp.say({ voice: "Polly.Joanna" }, "Thanks for calling. No agents are available right now. Please leave a message after the tone.");
      vrp.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
      return res.send(vrp.toString());
    }
    const conf = await createConference({
      silo: "BF", direction: "inbound", createdByUserId: null,
      friendlyName: `in_${callSid.slice(-12)}_${Date.now()}`,
    });
    const callerPid = await addParticipantRow({
      conferenceId: conf.id, kind: "pstn",
      phoneNumber: from, displayName: from,
    });
    if (callSid) await setParticipantCallSid(callerPid, callSid);
    const staffIds: string[] = [];
    await Promise.all(available.rows.map(async (row) => {
      const pid = await addParticipantRow({
        conferenceId: conf.id, kind: "staff",
        identity: row.twilio_identity, displayName: row.twilio_identity,
      });
      staffIds.push(String(row.user_id));
      try {
        await dialClientIntoConference({
          conferenceFriendly: conf.friendly_name,
          identity: row.twilio_identity, participantId: pid, fromNumber: from,
        });
      } catch (e: any) { console.warn("ring_all_dial_failed", { identity: row.twilio_identity, message: e?.message }); }
    }));
    void broadcastIncomingRing(staffIds, conf.friendly_name, from);
    const base = getPublicBaseUrl();
    vrp.redirect({ method: "POST" }, `${base}/api/webhooks/twilio/conference/join?conf=${encodeURIComponent(conf.friendly_name)}&pid=${encodeURIComponent(callerPid)}`);
    return res.send(vrp.toString());
  }

  const outboundFlag = params.outbound === "1" || params.outbound === 1 || params.outbound === true;
  const looksLikePhone = /^\+?\d{10,15}$/.test(to);
  // BF_SERVER_BLOCK_50_v1 -- match the fallback chain used by the
  // /api/telephony/outbound-call REST endpoint so the SAME env var
  // works for both REST-initiated and WebRTC-initiated calls. If the
  // operator set the outbound number under TWILIO_FROM_NUMBER,
  // TWILIO_PHONE_NUMBER, TWILIO_FROM, or TWILIO_PHONE, those need to
  // resolve here too. Without this, Twilio's edge calls vr.dial with
  // callerId="" and rejects error 13225 "Invalid From attribute",
  // disconnecting the call within ~10ms of connect.
  const callerId =
       process.env.TWILIO_CALLER_ID
    || process.env.TWILIO_NUMBER
    || process.env.TWILIO_FROM_NUMBER
    || process.env.TWILIO_PHONE_NUMBER
    || process.env.TWILIO_FROM
    || process.env.TWILIO_PHONE
    || "";

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
  // BF_SERVER_BLOCK_50_v1 -- guard against empty callerId. Twilio
  // rejects vr.dial with no callerId for outbound; speak the failure
  // instead so the operator hears it instead of an instant hangup.
  if ((looksLikePhone || outboundFlag) && to && !callerId) {
    vr.say({ voice: "Polly.Joanna" },
      "Outbound calling is not configured. Please set the Twilio caller ID environment variable on the server.");
    vr.hangup();
    res.send(vr.toString());
    return;
  }
  if ((looksLikePhone || outboundFlag) && to) {
    const dial = vr.dial({ callerId, answerOnBridge: true, timeout: 30 });
    dial.number(to);
  } else if (rawFrom.startsWith("client:")) {
    // BF_SERVER_STAFF_LEG_NO_VOICEMAIL_v1 — a staff browser (SDK) leg that
    // lands here has no conference to join (it ended, or the callee never
    // answered). Hang up. A staff leg must never be routed to the inbound
    // "leave a message" voicemail — that produced phantom voicemails and the
    // "no agents available" the operator heard on their own outbound call.
    vr.hangup();
  } else {
    vr.say({ voice: "Polly.Joanna" }, "Sorry, no agents are available right now. Please leave a message after the tone.");
    vr.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
  }

  const twiml = vr.toString();
  console.log(JSON.stringify({ event: "voice_twiml_generated", to, from, callerId: callerId || null, twiml })); // BF_SERVER_BLOCK_v103_VOICE_TWIML_LOGGING_v1
  res.type("text/xml").send(twiml);
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

  const { RecordingUrl, RecordingDuration, RecordingSid, CallSid, From } = req.body ?? {};
  if (RecordingUrl && CallSid) {
    const fromNum = typeof From === "string" ? From : null;
    // Look up contact by phone
    const contact = fromNum
      ? await pool.query<{ id: string }>(
          // BF_SERVER_BLOCK_v637_MOBILE_PHONE_AND_BACKFILL_v1 — contacts.mobile_phone does not exist.
          `SELECT id FROM contacts
            WHERE right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace($1::text,            '[^0-9]', '', 'g'), 10)
            LIMIT 1`,
          [fromNum]
        ).then((r) => r.rows[0] ?? null).catch(() => null)
      : null;

    // BF_SERVER_VOICEMAIL_PER_STAFF_v1 - stamp the staff member the call was for
    // so the voicemail is private to them (Todd sees only Todd's, etc.).
    // BF_SERVER_PHONE_HOTFIX_v1 - the reception IVR passes the resolved target staff as
    // ?staff=<userId>; prefer it, else fall back to the call_log lookup.
    const staffHint = typeof req.query?.staff === "string" && req.query.staff.trim() ? String(req.query.staff).trim() : null;
    const vmStaffUserId = staffHint ?? await findCallLogByTwilioSid(String(CallSid))
      .then((cl) => cl?.staff_user_id ?? null)
      .catch(() => null);
    await pool.query(
      `INSERT INTO voicemails (id, call_sid, recording_sid, recording_url, duration, from_number, contact_id, staff_user_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT DO NOTHING`,
      [
        String(CallSid),
        String(RecordingSid ?? CallSid),
        String(RecordingUrl),
        parseInt(String(RecordingDuration ?? "0"), 10) || 0,
        fromNum,
        contact?.id ?? null,
        vmStaffUserId,
      ]
    ).catch((e: any) => console.error("voicemail_insert_failed", e?.message));
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

// BF_SERVER_BLOCK_80_SMS_INBOUND_PERSIST_v1 - writes to communications_messages
// (was hitting non-existent `messages` table, silently swallowing the error).
// Broader phone lookup matches the voicemail handler on line 209.
async function persistInboundSms(req: any): Promise<void> {
  const { Body, From, To, MessageSid } = req.body ?? {};
  // BF_SERVER_SMS_MEDIA_v1 — capture inbound MMS media (Twilio posts NumMedia + MediaUrl0..N)
  // and stop dropping caption-less image MMS (Body empty but media present).
  const numMedia = Number.parseInt(String(req.body?.NumMedia ?? "0"), 10) || 0;
  const mediaUrl = numMedia > 0 ? (String(req.body?.MediaUrl0 ?? "").trim() || null) : null;
  if (!From || (!Body && !mediaUrl)) return;

  const fromNum = String(From);
  const toNum = typeof To === "string" ? To : null;
  const body = Body ? String(Body) : "[media]";
  const sid = typeof MessageSid === "string" ? MessageSid : null;

  // BF_SERVER_BLOCK_v637_MOBILE_PHONE_AND_BACKFILL_v1 — contacts.mobile_phone does not exist.
  const contact = await pool.query<{ id: string; silo: string | null }>(
    `SELECT id, silo FROM contacts
            WHERE right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10)
                = right(regexp_replace($1::text,            '[^0-9]', '', 'g'), 10)
            ORDER BY created_at ASC NULLS LAST, id ASC
            LIMIT 1`,
    [fromNum]
  ).then((r) => r.rows[0] ?? null).catch(() => null);

  let resolvedSilo = contact?.silo ?? null;
  if (!resolvedSilo && toNum) {
    const toSilo = await pool.query<{ silo: string | null }>(
      `SELECT silo
         FROM communications_messages
        WHERE right(regexp_replace(coalesce(to_number, ''), '[^0-9]', '', 'g'), 10)
            = right(regexp_replace($1::text,                '[^0-9]', '', 'g'), 10)
          AND silo IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [toNum]
    ).then((r) => r.rows[0]?.silo ?? null).catch(() => null);
    resolvedSilo = toSilo;
  }
  resolvedSilo = resolvedSilo ?? "BF";

  // v635_sms_match_log: log the contact lookup outcome so silent
  // persists are visible in Azure log stream.
  console.log(JSON.stringify({
    event: "sms_inbound_contact_match",
    from: fromNum,
    matched_contact_id: contact?.id ?? null,
    silo: resolvedSilo,
    sid,
  }));

  // BF_SERVER_BLOCK_v345_BI_OUTREACH_ENGAGED_v1 — an inbound SMS reply from a BI
  // outreach lead advances their pipeline stage to Engaged (matched by phone).
  void bumpBiOutreachToEngagedByPhone(fromNum);

  // ON CONFLICT on comm_messages_twilio_sid_idx (unique partial index from
  // migration 109) makes Twilio retries idempotent without a duplicate row.
  await pool.query(
    `INSERT INTO communications_messages
       (id, type, direction, status, contact_id, body, media_url, from_number, to_number, phone_number, twilio_sid, silo, created_at)
     VALUES (gen_random_uuid(), 'sms', 'inbound', 'received', $1, $2, $3, $4, $5, $4, $6, $7, now())
     ON CONFLICT (twilio_sid) WHERE twilio_sid IS NOT NULL DO NOTHING`,
    [contact?.id ?? null, body, mediaUrl, fromNum, toNum, sid, resolvedSilo]
  ).catch((err) => {
    // Surface the failure in logs instead of swallowing it silently.
    console.error({ event: "sms_inbound_persist_failed", err: String(err) });
  });

  eventBus.emit("sms.inbound.received", {
    contactId: contact?.id ?? null,
    from: fromNum,
    to: toNum,
    body,
    sid,
  });
  console.log(JSON.stringify({
    event: "sms_inbound_persisted",
    contact_id: contact?.id ?? null,
    silo: resolvedSilo,
    sid,
  }));
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
