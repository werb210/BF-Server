// BF_SERVER_RECEPTION_v1 (+ NOVA_VOICE_v1) — Maya phone receptionist.
// Speech + keypad fallback. Rings Todd (sales) / Andrew (underwriting &
// named-lender) on their browser softphone only when genuinely available
// (presence = hours + on-call + in-meeting + manual), else offers "take a
// message" or "leave a voicemail". Every dead-end records to /voicemail.
//
// Voice: defaults to Polly. When RECEPTION_NOVA_VOICE=true, every line is
// played from Maya's nova voice via the key-gated /voice endpoint below
// (rendered once, cached, warmed at boot). If OpenAI is unreachable the flag
// can simply be turned off to revert to Polly with no redeploy.
import express, { Router, type Request, type Response } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { pool } from "../db.js";
import { config } from "../config/index.js";

const router = Router();

// Twilio webhooks post application/x-www-form-urlencoded payloads, and the
// signature validator needs the parsed params to validate the request.
router.use(express.urlencoded({ extended: false }));

const VOICE = "Polly.Joanna";
const BASE = "/api/webhooks/twilio/reception";

const PHRASES: Record<string, string> = {
  greeting: "This call is recorded for quality. Welcome to the Boreal Group of Companies. Are you looking to reach Boreal Financial, or Boreal Risk Management? You can say it, or press 1 for Financial, 2 for Risk Management.",
  intent_prompt: "Thanks. What can I help you with, or who would you like to reach? You can say sales, underwriting, or a person's name. Or press 1 for sales, 2 for underwriting.",
  offer: "Would you like me to take a message and pass it on, or would you like to leave a voicemail? Say message, or press 1. Say voicemail, or press 2.",
  record_prompt: "Please leave your name, number, and a brief message after the tone.",
  vm_prompt: "Please leave your message after the tone.",
  msg_prompt: "Sure — please tell me your name, number, and what it's about after the tone, and I'll pass it to the team.",
  opener_caden: "Let me take a message for the team.",
  opener_address1: "You can reach us through the contact form on our website.",
  opener_address2: "I can also take your details and notify the team.",
  opener_unclear: "Let me take a message and make sure the right person follows up.",
  connect_todd: "One moment, connecting you to Todd.",
  connect_andrew: "One moment, connecting you to Andrew.",
  reason_todd_oncall: "Sorry, Todd is on another call.",
  reason_andrew_oncall: "Sorry, Andrew is on another call.",
  reason_todd_unavail: "Sorry, Todd isn't available right now.",
  reason_andrew_unavail: "Sorry, Andrew isn't available right now.",
  noanswer_todd: "Sorry, Todd didn't pick up.",
  noanswer_andrew: "Sorry, Andrew didn't pick up.",
};

const audioCache = new Map<string, Buffer>();
function novaOn(): boolean { return process.env.RECEPTION_NOVA_VOICE === "true"; }

async function renderNova(text: string): Promise<Buffer | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey });
    const speech = await client.audio.speech.create({ model: "tts-1", voice: "nova", input: text });
    return Buffer.from(await speech.arrayBuffer());
  } catch { return null; }
}

export async function warmReceptionVoice(): Promise<void> {
  for (const [key, text] of Object.entries(PHRASES)) {
    if (audioCache.has(key)) continue;
    const buf = await renderNova(text);
    if (buf) audioCache.set(key, buf);
  }
}

function emit(node: any, key: string, text: string): void {
  if (novaOn()) node.play(`${BASE}/voice?key=${key}`);
  else node.say({ voice: VOICE }, text);
}

function speech(req: Request): string { return String((req.body?.SpeechResult ?? "") as string).toLowerCase(); }
function digit(req: Request): string { return String((req.body?.Digits ?? "") as string).trim(); }
async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response { res.setHeader("Content-Type", "text/xml"); return res.send(v.toString()); }

type Target = "sales" | "underwriting";
function displayFor(t: Target): string { return t === "sales" ? "Todd" : "Andrew"; }
function lkey(t: Target): string { return t === "sales" ? "todd" : "andrew"; }

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function resolveTarget(t: Target): Promise<{ identity: string | null; available: boolean; onCall: boolean; clientReady: boolean; cell: string | null; userId: string | null }> {
  const nameLike = t === "sales" ? "%todd%" : "%andrew%";
  try {
    const { rows } = await pool.query<{ status: string; twilio_identity: string | null; on_call: boolean; fresh: boolean; phone: string | null; user_id: string | null }>(
      `SELECT sp.status, sp.twilio_identity, coalesce(sp.on_call, false) AS on_call, u.id AS user_id,
              (sp.last_heartbeat > now() - interval '90 seconds') AS fresh,
              coalesce(u.phone_number, u.phone) AS phone
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE (u.first_name ILIKE $1 OR u.last_name ILIKE $1) ORDER BY sp.last_heartbeat DESC NULLS LAST LIMIT 1`,
      [nameLike],
    );
    const r = rows[0];
    if (!r) return { identity: null, available: false, onCall: false, clientReady: false, cell: null, userId: null };
    const clientReady = r.status === "available" && !!r.twilio_identity && !!r.fresh;
    return { identity: r.twilio_identity, available: r.status === "available" && !!r.twilio_identity, onCall: !!r.on_call, clientReady, cell: toE164(r.phone), userId: r.user_id ?? null };
  } catch { return { identity: null, available: false, onCall: false, clientReady: false, cell: null, userId: null }; }
}

function offerMessageOrVoicemail(v: any, openerKey: string, openerText: string, staffUserId?: string | null): void {
  // BF_SERVER_RECEPTION_VOICEMAIL_ONLY_v1 — no "take a message vs voicemail"
  // choice; play the opener, then go straight to recording a voicemail.
  emit(v, openerKey, openerText);
  emit(v, "record_prompt", PHRASES.record_prompt);
  // BF_SERVER_PHONE_HOTFIX_v1 - when the caller asked for a specific person, stamp the
  // voicemail with that staff user id so it stays private to them (Todd sees Todd's).
  const action = staffUserId ? `/api/webhooks/twilio/voicemail?staff=${encodeURIComponent(staffUserId)}` : "/api/webhooks/twilio/voicemail";
  v.record({ maxLength: 120, playBeep: true, action });
}

router.get("/voice", async (req: Request, res: Response) => {
  const key = String(req.query.key || "");
  const text = PHRASES[key];
  if (!text) return res.status(404).end();
  let buf = audioCache.get(key);
  if (!buf) {
    const rendered = await renderNova(text);
    if (!rendered) return res.status(503).end();
    audioCache.set(key, rendered);
    buf = rendered;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(buf);
});

router.post("/greeting", twilioWebhookValidation, async (_req: Request, res: Response) => {
  const v = await newVR();
  const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action: `${BASE}/company`, method: "POST" });
  emit(g, "greeting", PHRASES.greeting);
  v.redirect({ method: "POST" }, `${BASE}/company`);
  return send(res, v);
});

router.post("/company", twilioWebhookValidation, async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  let company = "BF";
  if (d === "2" || /risk|insurance|brm|management/.test(s)) company = "BRM";
  else if (d === "1" || /financ|finance|loan|funding|\bbf\b/.test(s)) company = "BF";
  const v = await newVR();
  const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action: `${BASE}/intent?company=${company}`, method: "POST" });
  emit(g, "intent_prompt", PHRASES.intent_prompt);
  v.redirect({ method: "POST" }, `${BASE}/intent?company=${company}`);
  return send(res, v);
});

router.post("/intent", twilioWebhookValidation, async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  if (/caden/.test(s)) { offerMessageOrVoicemail(v, "opener_caden", PHRASES.opener_caden); return send(res, v); }
  if (/address|location|where are you|directions/.test(s)) {
    emit(v, "opener_address1", PHRASES.opener_address1);
    offerMessageOrVoicemail(v, "opener_address2", PHRASES.opener_address2); return send(res, v);
  }
  const wantsAndrew = d === "2" || /andrew|underwrit|document|condition|approval|declin|status|lender/.test(s);
  const wantsTodd = d === "1" || /todd|sales|apply|\bnew\b|financ|funding|loan|quote|get started/.test(s);
  const target: Target | null = wantsAndrew ? "underwriting" : wantsTodd ? "sales" : null;
  if (!target) { offerMessageOrVoicemail(v, "opener_unclear", PHRASES.opener_unclear); return send(res, v); }
  const t = await resolveTarget(target);
  const name = displayFor(target);
  // BF_SERVER_RECEPTION_SIMRING_v1 — ring the softphone only when its heartbeat
  // is fresh (a stale "available" row was dialing a dead WebRTC client -> 0-sec
  // no-answer); ALSO ring the staff cell so they're reachable regardless of the
  // browser softphone. First leg to answer wins.
  // BF_SERVER_PHONE_HOTFIX_v1 - forward the ORIGINAL caller's number so staff see who
  // is calling (Twilio allows the inbound caller's number as callerId when forwarding).
  const callerId = String((req.body?.From ?? "")).trim() || config.twilio.callerId || config.twilio.from || config.twilio.number || undefined;
  if (t.clientReady || t.cell) {
    emit(v, `connect_${lkey(target)}`, `One moment, connecting you to ${name}.`);
    const dial = v.dial({ answerOnBridge: true, timeout: 25, action: `${BASE}/unavailable?target=${target}`, method: "POST", callerId });
    if (t.clientReady && t.identity) dial.client(t.identity);
    if (t.cell) dial.number(t.cell);
    return send(res, v);
  }
  const reasonKey = t.onCall ? `reason_${lkey(target)}_oncall` : `reason_${lkey(target)}_unavail`;
  const reasonText = `Sorry, ${name} ${t.onCall ? "is on another call" : "isn't available right now"}.`;
  offerMessageOrVoicemail(v, reasonKey, reasonText, t.userId);
  return send(res, v);
});

router.post("/unavailable", twilioWebhookValidation, async (req: Request, res: Response) => {
  const target = (String(req.query.target || "") === "underwriting" ? "underwriting" : "sales") as Target;
  const dialStatus = String(req.body?.DialCallStatus ?? "");
  const v = await newVR();
  if (dialStatus === "completed") { v.hangup(); return send(res, v); }
  const tt = await resolveTarget(target);
  offerMessageOrVoicemail(v, `noanswer_${lkey(target)}`, `Sorry, ${displayFor(target)} didn't pick up.`, tt.userId);
  return send(res, v);
});

router.post("/fallback", twilioWebhookValidation, async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  const wantsVoicemail = d === "2" || /voicemail|voice mail|\bvm\b|message later/.test(s);
  if (wantsVoicemail) emit(v, "vm_prompt", PHRASES.vm_prompt);
  else emit(v, "msg_prompt", PHRASES.msg_prompt);
  v.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
  return send(res, v);
});

if (novaOn()) { void warmReceptionVoice(); }

export default router;
