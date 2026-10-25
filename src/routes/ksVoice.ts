// BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone phone line: Twilio webhooks under /api/webhooks/twilio/ks.
//   POST /voice       the Keystone number's "A call comes in" URL: greeting + menu (1 sales, 2 support)
//   POST /menu        the caller's choice -> that queue (rings the queue's staff, or voicemail when closed / nobody free)
//   POST /no-answer   nobody picked up -> voicemail
//   POST /voicemail   the recording: saved, transcribed and filed like every BF voicemail (silo KS); support
//                     voicemails also go on a support ticket
// Every request carries a valid Twilio signature (twilioWebhookValidation, BF-Server's Twilio auth token), so the
// Keystone number must be in the same Twilio account as BF-Server (see the v853 block notes).
// Staff ring in the iPhone dialler and the portal softphone exactly as for BF calls: the same <Client> identities,
// caller card parameters, recording (rx_<CallSid>), leg-status callbacks and AI summary pipeline, filed under silo KS.
import express, { Router, type Request, type Response } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { dialClient } from "../voice/callerCard.js";
import { identitiesOutsideHours } from "../voice/callHours.js";
import { closeCallRecord, inboundRecordName, legStatusAttrs, recordingDialAttrs } from "../voice/recordedDial.js";
import { openInboundRecord } from "../voice/staffRing.js";
import { dialWasNotAnswered } from "../voice/watchCellFallback.js";
import {
  e164, isKsQueue, ksCallerCard, ksVoiceEnabled, loadQueueSettings, matchKsCallerSafe, queueAlertUserIds, queueIsOpen, ringGroup,
  type KsQueue,
} from "../modules/ks/ksPhone.js";
import { notifyStaff, recordSupportCall, recordSupportVoicemail } from "../modules/ks/ksSupport.js";

const router = Router();
router.use(express.urlencoded({ extended: false }));

export const KS_VOICE_BASE = "/api/webhooks/twilio/ks";
const VOICE = "Polly.Joanna";

export const KS_PHRASES = {
  greeting: "Thanks for calling Keystone. This call may be recorded. Press 1 for sales, 2 for support.",
  retry: "Sorry, I didn't catch that. Press 1 for sales, 2 for support.",
  connecting: (queue: KsQueue) => `One moment, connecting you to Keystone ${queue}.`,
  closed: (queue: KsQueue) => `Keystone ${queue} is closed right now. Please leave your name, number and a short message after the tone, and we will call you back.`,
  nobody: "Sorry, no one is available to take your call right now. Please leave your name, number and a short message after the tone.",
  noAnswer: "Sorry, no one was able to pick up. Please leave your name, number and a short message after the tone.",
  thanks: "Thank you. We will be in touch shortly. Goodbye.",
  offline: "Sorry, this Keystone line is not in service yet. Goodbye.",
};

async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response {
  res.setHeader("Content-Type", "text/xml");
  return res.send(v.toString());
}
const callSidOf = (req: Request) => String(req.body?.CallSid ?? "").trim();
const fromOf = (req: Request) => String(req.body?.From ?? "").trim();

/** 1 / "sales" -> sales, 2 / "support" / "help" -> support, anything else null. */
export function menuChoice(digits: unknown, speech: unknown): KsQueue | null {
  const d = String(digits ?? "").replace(/[^0-9]/g, "").slice(0, 1);
  if (d === "1") return "sales";
  if (d === "2") return "support";
  const s = String(speech ?? "").toLowerCase();
  if (/support|help|problem|issue|broken|technical/.test(s)) return "support";
  if (/sales|sale|buy|pricing|price|demo|sign up|signup/.test(s)) return "sales";
  return null;
}

function voicemail(v: any, queue: KsQueue): void {
  v.record({ maxLength: 180, playBeep: true, action: `${KS_VOICE_BASE}/voicemail?queue=${queue}`, method: "POST" });
}

function missedCallAlert(req: Request, queue: KsQueue, userIds: string[]): void {
  const from = e164(fromOf(req)) ?? (fromOf(req) || "an unknown number");
  void notifyStaff({
    userIds,
    title: `Missed Keystone ${queue} call`,
    body: `Missed call from ${from} on the Keystone ${queue} line.`,
    contextUrl: queue === "support" ? "/silo/ks/crm/support" : "/silo/ks/crm/contacts",
    staffAlert: { category: "MISSED_CALL", type: "missed_call", data: { phone: from } },
  });
}

router.post("/voice", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  // The end-of-call status callback can be pointed here by mistake: it is not a new call.
  const status = String(req.body?.CallStatus ?? "").toLowerCase();
  if (req.body?.CallbackSource || ["completed", "canceled", "busy", "failed", "no-answer"].includes(status)) return send(res, v);
  if (!ksVoiceEnabled()) {
    console.warn(JSON.stringify({ event: "ks_voice_not_configured", callSid: callSidOf(req) || null }));
    v.say({ voice: VOICE }, KS_PHRASES.offline);
    v.hangup();
    return send(res, v);
  }
  const callSid = callSidOf(req);
  const from = fromOf(req);
  const caller = await matchKsCallerSafe(pool, from);
  // The call log row (silo KS) the status callback, the dialler's "who answered" and the voicemail pipeline all use.
  try {
    const { startCall } = await import("../modules/calls/calls.service.js");
    await startCall({
      phoneNumber: from || "unknown",
      fromNumber: from || null,
      toNumber: String(req.body?.To ?? "").trim() || null,
      direction: "inbound",
      status: "initiated",
      staffUserId: null,
      twilioCallSid: callSid || null,
      crmContactId: caller.contactId,
      silo: "KS",
    });
  } catch (err) {
    console.warn("[ks-voice] call log create failed", { callSid, message: err instanceof Error ? err.message : String(err) });
  }
  console.log(JSON.stringify({ event: "ks_voice_inbound", callSid: callSid || null, matched: caller.found, contactId: caller.contactId, companyId: caller.companyId }));
  const g = v.gather({ input: "dtmf speech", numDigits: 1, timeout: 6, speechTimeout: "auto", hints: "sales, support", action: `${KS_VOICE_BASE}/menu`, method: "POST" });
  g.say({ voice: VOICE }, KS_PHRASES.greeting);
  v.redirect({ method: "POST" }, `${KS_VOICE_BASE}/menu?retry=0`);
  return send(res, v);
}));

router.post("/menu", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  let queue = menuChoice(req.body?.Digits, req.body?.SpeechResult);
  const retry = String(req.query.retry ?? "");
  if (!queue && retry !== "1") {
    // One more try (no key at all on the first pass lands here with retry=0).
    const g = v.gather({ input: "dtmf speech", numDigits: 1, timeout: 6, speechTimeout: "auto", hints: "sales, support", action: `${KS_VOICE_BASE}/menu?retry=1`, method: "POST" });
    g.say({ voice: VOICE }, KS_PHRASES.retry);
    v.redirect({ method: "POST" }, `${KS_VOICE_BASE}/menu?retry=1`);
    return send(res, v);
  }
  if (!queue) queue = "sales"; // no choice after the retry: sales (new callers are more often prospects)
  console.log(JSON.stringify({ event: "ks_voice_menu", callSid: callSidOf(req) || null, queue, digits: req.body?.Digits ?? null }));
  await ringQueue(v, req, queue);
  return send(res, v);
}));

/** Rings the queue's staff, or sends the caller to voicemail (closed / nobody available). */
export async function ringQueue(v: any, req: Request, queue: KsQueue): Promise<void> {
  const settings = await loadQueueSettings(pool, queue);
  const callSid = callSidOf(req);
  const from = fromOf(req);
  const caller = await matchKsCallerSafe(pool, from);
  const open = queueIsOpen(settings);
  if (queue === "support") {
    // Every support call goes on a ticket straight away (answered or not); the voicemail, if any, joins it later.
    void recordSupportCall(pool, { callSid, from, caller, afterHours: !open })
      .catch((err: unknown) => console.warn("[ks-voice] support ticket for call failed", { callSid, message: err instanceof Error ? err.message : String(err) }));
  }
  if (!open) {
    v.say({ voice: VOICE }, KS_PHRASES.closed(queue));
    voicemail(v, queue);
    return;
  }
  const members = await ringGroup(pool, settings);
  const away = await identitiesOutsideHours(pool, members.map((m) => m.identity));
  const ring = members.filter((m) => !away.has(m.identity));
  if (!ring.length) {
    missedCallAlert(req, queue, await queueAlertUserIds(pool, settings));
    v.say({ voice: VOICE }, KS_PHRASES.nobody);
    voicemail(v, queue);
    return;
  }
  const card = ksCallerCard(caller, queue, from);
  const rec = await openInboundRecord(pool, { callSid, from, card, silo: "KS" });
  v.say({ voice: VOICE }, KS_PHRASES.connecting(queue));
  const dial = v.dial({
    answerOnBridge: true,
    timeout: settings.ringTimeoutSeconds,
    action: `${KS_VOICE_BASE}/no-answer?queue=${queue}`,
    method: "POST",
    callerId: from || undefined,
    ...recordingDialAttrs(rec),
  });
  const legName = rec ?? (callSid ? inboundRecordName(callSid) : null);
  for (const m of ring) dialClient(dial, m.identity, card, legStatusAttrs(legName, m.identity));
}

router.post("/no-answer", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const queue: KsQueue = isKsQueue(req.query.queue) ? req.query.queue : "sales";
  const callSid = callSidOf(req);
  if (!dialWasNotAnswered(req.body?.DialCallStatus)) {
    if (callSid) void closeCallRecord(pool, inboundRecordName(callSid));
    v.hangup();
    return send(res, v);
  }
  const settings = await loadQueueSettings(pool, queue);
  missedCallAlert(req, queue, await queueAlertUserIds(pool, settings));
  if (callSid) void closeCallRecord(pool, inboundRecordName(callSid));
  v.say({ voice: VOICE }, KS_PHRASES.noAnswer);
  voicemail(v, queue);
  return send(res, v);
}));

router.post("/voicemail", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const queue: KsQueue = isKsQueue(req.query.queue) ? req.query.queue : "sales";
  const callSid = callSidOf(req);
  const recordingUrl = String(req.body?.RecordingUrl ?? "").trim();
  const recordingSid = String(req.body?.RecordingSid ?? "").trim() || callSid;
  const from = fromOf(req);
  const duration = parseInt(String(req.body?.RecordingDuration ?? "0"), 10) || null;
  // The bare row first (silo KS), so a transcription outage never loses the voicemail; enrichment upserts onto it.
  if (recordingUrl && callSid) {
    await pool.query(
      `INSERT INTO voicemails (id, call_sid, recording_sid, recording_url, duration, from_number, silo, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'KS', now())
       ON CONFLICT (recording_sid) DO NOTHING`,
      [callSid, recordingSid, recordingUrl, duration ?? 0, from || null],
    ).catch((err: unknown) => console.error("[ks-voice] voicemail insert failed", { callSid, message: err instanceof Error ? err.message : String(err) }));
  }
  const v = await newVR();
  v.say({ voice: VOICE }, KS_PHRASES.thanks);
  v.hangup();
  send(res, v);
  if (!recordingUrl || !callSid) return;
  void afterKsVoicemail({ queue, callSid, recordingSid, recordingUrl, duration, from })
    .catch((err: unknown) => console.error("[ks-voice] voicemail follow-up failed", { callSid, message: err instanceof Error ? err.message : String(err) }));
}));

/** Transcribe + file (shared pipeline), then the support ticket and the queue's alert. */
export async function afterKsVoicemail(a: { queue: KsQueue; callSid: string; recordingSid: string; recordingUrl: string; duration: number | null; from: string }): Promise<void> {
  // Enrichment may create an unlinked Unknown caller contact. Keep the company matched before that insert.
  const matched = await matchKsCallerSafe(pool, a.from);
  const { enrichAndDistributeVoicemail } = await import("../modules/voice/voicemailEnrich.service.js");
  await enrichAndDistributeVoicemail({
    callSid: a.callSid, recordingSid: a.recordingSid, recordingUrl: a.recordingUrl, durationSeconds: a.duration, fromNumber: a.from, staffUserId: null,
  });
  const vm = await pool.query(
    `SELECT transcript, contact_id::text AS contact_id, coalesce(blob_url, recording_url) AS url FROM voicemails WHERE recording_sid = $1 LIMIT 1`,
    [a.recordingSid],
  );
  const row = vm.rows[0] ?? {};
  const enriched = await matchKsCallerSafe(pool, a.from);
  const caller = {
    ...enriched,
    companyId: enriched.companyId ?? matched.companyId,
    companyName: enriched.companyName ?? matched.companyName,
    supportLevel: enriched.supportLevel ?? matched.supportLevel,
  };
  const contactId: string | null = caller.contactId ?? row.contact_id ?? null;
  if (contactId) {
    // The call log gets the contact the voicemail pipeline found or created, so the call shows on their timeline.
    await pool.query(`UPDATE call_logs SET crm_contact_id = coalesce(crm_contact_id, $2::uuid), updated_at = now() WHERE twilio_call_sid = $1`, [a.callSid, contactId])
      .catch((err: unknown) => console.warn("[ks-voice] call log contact update failed", { callSid: a.callSid, message: err instanceof Error ? err.message : String(err) }));
    if (caller.companyId) {
      await pool.query(`UPDATE contacts SET company_id = $2::uuid, updated_at = now() WHERE id = $1::uuid AND company_id IS NULL AND silo = 'KS'`, [contactId, caller.companyId])
        .catch((err: unknown) => console.warn("[ks-voice] contact company link failed", { contactId, message: err instanceof Error ? err.message : String(err) }));
    }
  }
  let ticketId: string | null = null;
  if (a.queue === "support") {
    ticketId = await recordSupportVoicemail(pool, {
      callSid: a.callSid, from: a.from, caller, transcript: row.transcript ?? null, recordingUrl: row.url ?? a.recordingUrl, contactId,
    });
  }
  const settings = await loadQueueSettings(pool, a.queue);
  const who = caller.contactName ?? caller.companyName ?? e164(a.from) ?? "an unknown caller";
  const said = String(row.transcript ?? "").replace(/\s+/g, " ").trim();
  await notifyStaff({
    userIds: await queueAlertUserIds(pool, settings),
    title: `Keystone ${a.queue} voicemail from ${who}`,
    body: said ? said.slice(0, 280) : "New voicemail",
    ticketId,
    contextUrl: ticketId ? null : contactId ? `/silo/ks/crm/contacts/${contactId}` : "/silo/ks/crm/contacts",
    staffAlert: { category: "VOICEMAIL", type: "voicemail", data: { contactId, phone: e164(a.from) } },
  });
}

export default router;
