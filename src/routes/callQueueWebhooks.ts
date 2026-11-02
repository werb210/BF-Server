// BF_SERVER_v871_CALL_QUEUES - Twilio webhooks for call queues (/api/webhooks/twilio/queue, signature checked).
// Ported from KS-server #47 (src/routes/callQueueWebhooks.ts).
//   POST /wait?qc=             <Enqueue waitUrl>: greeting, place in line, hold message and music; runs the dispatcher
//   POST /left?qc=             <Enqueue action>: the caller left the queue (bridged, hung up, or <Leave/> -> overflow)
//   POST /overflow?qc=         the longest wait was reached: voicemail, callback request, or the caller's choice
//   POST /overflow-choice?qc=  "press 1 for a callback"
//   POST /bridge?qc=           the agent answered the offer: <Dial><Queue> connects them to the front caller
//   POST /connecting?qc=       <Queue url>: which caller was dequeued by which agent call (kept exact in the table)
//   POST /agent-done?qc=&user= the agent's <Dial> ended
//   POST /agent-status?qc=&user=  the agent's offer call ended (no answer / declined -> the next person)
import express, { Router, type Request, type Response } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { recordingDialAttrs, inboundRecordName } from "../voice/recordedDial.js";
import { staffVoicemail } from "../voice/staffRing.js";
import { alertMissedCall } from "../services/notifications/staffAlertEvents.js";
import {
  DEFAULT_HOLD_MUSIC, WEBHOOK_BASE, agentCallEnded, cancelOfferCall, dispatchQueue, getQueue, markConnected, offerMissed, setQueueTwilioForTests, twilioQueueName,
} from "../callQueues/queues.js";

const router = Router();
router.use(express.urlencoded({ extended: false }));
const VOICE = "Polly.Joanna";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response { res.setHeader("Content-Type", "text/xml"); return res.send(v.toString()); }
const qc = (req: Request) => { const id = String(req.query.qc ?? ""); return UUID.test(id) ? id : null; };
async function callRow(id: string | null) {
  if (!id) return null;
  return (await pool.query(`SELECT c.*, c.id::text AS id, c.queue_id::text AS queue_id FROM call_queue_calls c WHERE c.id = $1::uuid`, [id])).rows[0] ?? null;
}
/** Runs the dispatcher after the TwiML is sent (never delays the caller). */
function kick(queueId: string): void {
  setImmediate(() => { void dispatchQueue(pool, queueId).catch((err) => console.error("[call-queue] dispatch kick failed", err instanceof Error ? err.message : err)); });
}
export { setQueueTwilioForTests };

router.post("/wait", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const row = await callRow(qc(req));
  if (!row) { v.leave(); return send(res, v); }
  const queue = await getQueue(pool as any, row.queue_id);
  const position = Math.max(1, Number(req.body?.QueuePosition ?? 1) || 1);
  const waited = Number(req.body?.QueueTime ?? 0) || 0;
  await pool.query(`UPDATE call_queue_calls SET position = $2, twilio_queue_sid = COALESCE($3, twilio_queue_sid), wait_visits = wait_visits + 1 WHERE id = $1::uuid`,
    [row.id, position, String(req.body?.QueueSid ?? "") || null]);
  if (!queue || (row.status === "waiting" && waited >= queue.max_wait_seconds)) { v.leave(); return send(res, v); }
  if (Number(row.wait_visits) === 0 && queue.greeting) v.say({ voice: VOICE }, queue.greeting);
  if (queue.announce_position) v.say({ voice: VOICE }, position === 1 ? "You are next in line." : `You are caller number ${position} in line.`);
  if (queue.hold_message && Number(row.wait_visits) > 0) v.say({ voice: VOICE }, queue.hold_message);
  v.play({}, queue.hold_audio_id ? `/api/webhooks/twilio/reception/audio/${encodeURIComponent(queue.hold_audio_id)}` : DEFAULT_HOLD_MUSIC);
  kick(row.queue_id);
  return send(res, v);
}));

async function overflowTwiml(v: any, req: Request, row: any, choice: "voicemail" | "callback" | "ask" | null = null): Promise<void> {
  const queue = await getQueue(pool as any, row.queue_id);
  const mode = choice ?? queue?.overflow ?? "voicemail";
  if (mode === "ask") {
    const g = v.gather({ input: "dtmf", numDigits: 1, timeout: 6, action: `${WEBHOOK_BASE}/overflow-choice?qc=${row.id}`, method: "POST" });
    g.say({ voice: VOICE }, "Sorry for the wait. To have us call you back at this number, press 1. To leave a message, stay on the line.");
    v.redirect({ method: "POST" }, `${WEBHOOK_BASE}/overflow-choice?qc=${row.id}&vm=1`);
    return;
  }
  const status = mode === "callback" ? "callback" : "voicemail";
  await pool.query(`UPDATE call_queue_calls SET status = $2, outcome = $2, ended_at = now(), wait_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - enqueued_at))::int)
                     WHERE id = $1::uuid AND status IN ('waiting', 'offered')`, [row.id, status]);
  void alertMissedCall({ from: row.from_number ?? null, staffUserId: queue?.overflow_user_id ?? null, silo: queue?.silo === "BI" ? "BI" : "BF", callSid: row.call_sid ?? null });
  if (status === "callback") {
    v.say({ voice: VOICE }, "Thank you. We will call you back at this number as soon as someone is free. Goodbye.");
    v.hangup();
    return;
  }
  staffVoicemail(v, queue?.overflow_user_id ?? null, "Sorry, everyone is still busy. Please leave your name, number and a short message after the tone, and we will call you back.");
}

router.post("/left", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const row = await callRow(qc(req));
  const result = String(req.body?.QueueResult ?? "");
  if (!row) { v.hangup(); return send(res, v); }
  if (result === "leave") { await overflowTwiml(v, req, row); return send(res, v); }
  if (result === "hangup") {
    await pool.query(`UPDATE call_queue_calls SET status = 'abandoned', outcome = 'abandoned', ended_at = now(), wait_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - enqueued_at))::int)
                       WHERE id = $1::uuid AND status IN ('waiting', 'offered')`, [row.id]);
    if (row.status === "offered" && row.offer_call_sid) {
      try {
        await cancelOfferCall(String(row.offer_call_sid));
      } catch (err) {
        console.warn("[call-queue] could not stop ringing the agent", { message: err instanceof Error ? err.message : String(err) });
      }
    }
    v.hangup();
    return send(res, v);
  }
  if (result === "bridged" || result === "bridging-in-process") { v.hangup(); return send(res, v); }
  // queue-full, error, system-error, redirected: never leave a caller in silence.
  await overflowTwiml(v, req, row, "voicemail");
  return send(res, v);
}));

router.post("/overflow", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const row = await callRow(qc(req));
  if (!row) { staffVoicemail(v, null); return send(res, v); }
  await overflowTwiml(v, req, row);
  return send(res, v);
}));

router.post("/overflow-choice", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const row = await callRow(qc(req));
  if (!row) { staffVoicemail(v, null); return send(res, v); }
  const pressed = String(req.body?.Digits ?? "").trim();
  await overflowTwiml(v, req, row, pressed === "1" ? "callback" : "voicemail");
  return send(res, v);
}));

router.post("/bridge", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const row = await callRow(qc(req));
  const user = row?.offered_user_id ? String(row.offered_user_id) : "";
  if (!row || row.status !== "offered") {
    v.say({ voice: VOICE }, "Sorry, the caller has already hung up or been answered.");
    v.hangup();
    return send(res, v);
  }
  const queue = await getQueue(pool as any, row.queue_id);
  v.say({ voice: VOICE }, `${queue?.name ?? "Queue"} call.`);
  const dial = v.dial({ action: `${WEBHOOK_BASE}/agent-done?qc=${row.id}&user=${user}`, method: "POST", ...recordingDialAttrs(inboundRecordName(String(row.call_sid))) });
  dial.queue({ url: `${WEBHOOK_BASE}/connecting?qc=${row.id}`, method: "POST" }, twilioQueueName(row.queue_id));
  return send(res, v);
}));

router.post("/connecting", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const callerSid = String(req.body?.CallSid ?? "");
  const agentSid = String(req.body?.DequeingCallSid ?? "");
  if (callerSid && agentSid) {
    const r = await markConnected(pool as any, callerSid, agentSid);
    console.log(JSON.stringify({ event: "call_queue_connected", callId: r?.callId ?? null, userId: r?.userId ?? null }));
  }
  v.say({ voice: VOICE }, "Connecting you now.");
  return send(res, v);
}));

router.post("/agent-done", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const id = qc(req), user = String(req.query.user ?? "");
  if (id && UUID.test(user)) {
    const row = await callRow(id);
    await agentCallEnded(pool as any, id, user);
    if (row?.queue_id) kick(row.queue_id);
  }
  v.hangup();
  return send(res, v);
}));

router.post("/agent-status", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const id = qc(req), user = String(req.query.user ?? "");
  const status = String(req.body?.CallStatus ?? "").toLowerCase();
  const row = await callRow(id);
  if (row && UUID.test(user)) {
    if (row.status === "connected" && String(row.answered_user_id) === user) await agentCallEnded(pool as any, row.id, user);
    else if (["no-answer", "busy", "failed", "canceled", "completed"].includes(status)) await offerMissed(pool as any, row.id, user, String(req.body?.CallSid ?? "") || null);
    kick(row.queue_id);
  }
  res.status(204).end();
}));

export default router;
