// BF_SERVER_RECEPTION_v1 (+ NOVA_VOICE_v1) — Maya phone receptionist.
// Speech + keypad fallback. Financial: 1 client engagement (Todd + other signed-in staff,
// not Andrew), 2 credit (Andrew). Risk Management: Todd. Formerly sales / underwriting &
// named-lender, on their browser softphone only when genuinely available
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
  // BF_SERVER_RECEPTION_MENU_v698 - wording approved by Todd 2026-10-01.
  greeting: "This call may be recorded. Thank you for calling the Boreal Group of Companies. Are you looking for Boreal Financial, or Boreal Risk Management? You can say it, or press 1 for Financial, 2 for Risk Management.",
  intent_prompt: "Thank you for contacting Boreal Financial. For client engagement, press 1. For credit, press 2.",
  intent_retry: "Sorry, I didn't catch that. For client engagement, press 1. For credit, press 2.",
  connect_engagement: "One moment, connecting you to our client engagement team.",
  engagement_unavail: "Sorry, no one is available to take your call right now.",
  engagement_noanswer: "Sorry, no one was able to pick up.",
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
  if (!apiKey) {
    // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40
    // eslint-disable-next-line no-console
    console.warn("reception_voice_render_failed", { reason: "no_openai_api_key" });
    return null;
  }
  try {
    const OpenAI = (await import("openai")).default;
    const client = new OpenAI({ apiKey });
    const speech = await client.audio.speech.create({ model: "tts-1", voice: "nova", input: text });
    return Buffer.from(await speech.arrayBuffer());
  } catch (error) {
    // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40 - this catch swallowed everything.
    // A missing entitlement, a retired model, an expired key and a network blip
    // were indistinguishable and silent, which is why a dead phone line took a
    // caller to discover.
    // eslint-disable-next-line no-console
    console.warn("reception_voice_render_failed", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function warmReceptionVoice(): Promise<void> {
  for (const [key, text] of Object.entries(PHRASES)) {
    if (audioCache.has(key)) continue;
    const buf = await renderNova(text);
    if (buf) audioCache.set(key, buf);
  }
  // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40 - state plainly how many lines are
  // playable. A silent partial warm made a cold cache look like a healthy boot.
  if (novaOn()) {
    // eslint-disable-next-line no-console
    console.log("reception_voice_warm", {
      rendered: audioCache.size,
      total: Object.keys(PHRASES).length,
      degradedToPolly: Object.keys(PHRASES).length - audioCache.size,
    });
  }
}

// Test seam: the cache is module-local, and the fallback only means anything if
// a test can put the module into the cold and warm states deliberately.
export function __receptionVoiceCacheForTests() {
  return {
    set: (key: string, buf: Buffer) => { audioCache.set(key, buf); },
    clear: () => { audioCache.clear(); },
    size: () => audioCache.size,
  };
}

// BF_SERVER_RECEPTION_VOICE_FALLBACK_v40
// Confirmed in production 2026-08-11: GET /reception/voice?key=greeting returns
// 503, and a <Play> pointing at a 503 is an application error. Callers heard
// "an application error has occurred" and the call dropped, while this server
// logged a clean 200 for the greeting - because the greeting TwiML was valid.
// The failure was one hop later, inside Twilio's fetch of the audio.
//
// The cache is in-memory and per instance, warmed only at boot. Any restart
// while OpenAI is unreachable, or a swap onto a slot without a working key,
// leaves every prompt cold and every inbound call broken.
//
// So: only ever play audio that is already rendered. Everything else falls back
// to Polly, which fetches nothing. A less pleasant voice is not a defect. A
// phone line that answers with an error is.
export function shouldPlayAudio(key: string): boolean {
  return novaOn() && audioCache.has(key);
}

function emit(node: any, key: string, text: string): void {
  if (shouldPlayAudio(key)) node.play(`${BASE}/voice?key=${key}`);
  else node.say({ voice: VOICE }, text);
}

function speech(req: Request): string { return String((req.body?.SpeechResult ?? "") as string).toLowerCase(); }
function digit(req: Request): string { return String((req.body?.Digits ?? "") as string).trim(); }
async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response { res.setHeader("Content-Type", "text/xml"); return res.send(v.toString()); }

type Target = "sales" | "underwriting" | "engagement";
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

async function resolveTarget(t: Target): Promise<{ identity: string | null; available: boolean; onCall: boolean; clientReady: boolean; cell: string | null; standaloneWatch: boolean; userId: string | null }> {
  const nameLike = t === "sales" ? "%todd%" : "%andrew%";
  try {
    const { rows } = await pool.query<{ status: string; twilio_identity: string | null; on_call: boolean; fresh: boolean; phone: string | null; standalone_watch: boolean; user_id: string | null }>(
      `SELECT sp.status, sp.twilio_identity, coalesce(sp.on_call, false) AS on_call, u.id AS user_id,
              ((sp.last_heartbeat > now() - interval '90 seconds') OR EXISTS (
                SELECT 1 FROM staff_device_credentials dc WHERE dc.user_id = u.id AND dc.revoked_at IS NULL
                  AND dc.expires_at > now())) AS fresh, -- BF_SERVER_PHONE_ROUTING_v688b: signed in on the dialler app counts
              u.verified_callback_number AS phone,
              (u.callback_verified_at IS NOT NULL AND EXISTS (
                SELECT 1 FROM watch_devices wd WHERE wd.staff_user_id=u.id AND wd.revoked_at IS NULL
                  AND wd.standalone_routing_enabled=true)) AS standalone_watch
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE (u.first_name ILIKE $1 OR u.last_name ILIKE $1) ORDER BY sp.last_heartbeat DESC NULLS LAST LIMIT 1`,
      [nameLike],
    );
    const r = rows[0];
    if (!r) return { identity: null, available: false, onCall: false, clientReady: false, cell: null, standaloneWatch: false, userId: null };
    const clientReady = r.status === "available" && !!r.twilio_identity && !!r.fresh;
    return { identity: r.twilio_identity, available: r.status === "available" && !!r.twilio_identity, onCall: !!r.on_call, clientReady, cell: toE164(r.phone), standaloneWatch: !!r.standalone_watch, userId: r.user_id ?? null };
  } catch { return { identity: null, available: false, onCall: false, clientReady: false, cell: null, standaloneWatch: false, userId: null }; }
}

// Every signed-in, free staff member except Andrew, for the client-engagement group ring.
async function readyStaffIdentities(excludeUserId: string | null): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ twilio_identity: string }>(
      `SELECT DISTINCT sp.twilio_identity
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE sp.status = 'available' AND sp.twilio_identity IS NOT NULL
          AND coalesce(sp.on_call, false) = false AND coalesce(u.active, true) = true
          AND ((sp.last_heartbeat > now() - interval '90 seconds') OR EXISTS (
                SELECT 1 FROM staff_device_credentials dc WHERE dc.user_id = u.id AND dc.revoked_at IS NULL
                  AND dc.expires_at > now()))
          AND ($1::text IS NULL OR u.id::text <> $1)
          AND NOT (coalesce(u.first_name, '') ILIKE '%andrew%' OR coalesce(u.last_name, '') ILIKE '%andrew%')
        LIMIT 9`,
      [excludeUserId],
    );
    return rows.map((r) => r.twilio_identity).filter(Boolean);
  } catch (err: any) {
    console.warn("[reception] ready staff lookup failed", { message: err?.message });
    return [];
  }
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
    // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40 - emit() no longer points a live
    // call at an unrendered key, so a 503 here can no longer reach a caller.
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
  if (company === "BRM") { v.redirect({ method: "POST" }, `${BASE}/intent?company=BRM`); return send(res, v); }
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
  const wantsAndrew = d === "2" || /credit|andrew|underwrit|document|condition|approval|declin|status|lender/.test(s);
  const wantsTodd = d === "1" || /client|engag|todd|sales|apply|\bnew\b|financ|funding|loan|quote|get started/.test(s);
  const isBrm = String(req.query.company ?? "BF") === "BRM";
  let target: Target | null = isBrm ? "sales" : wantsAndrew ? "underwriting" : wantsTodd ? "engagement" : null;
  // BF_SERVER_VOICE_AUDIT_v686 - retain the caller's attempted response in logs,
  // then give an unclear caller one explicit keypad retry before voicemail.
  console.log(JSON.stringify({ event: "reception_intent", callSid: req.body?.CallSid ?? null, speech: s || null, digits: d || null, target, retry: String(req.query.retry ?? "") === "1" }));
  if (!target && String(req.query.retry ?? "") !== "1") {
    const company = String(req.query.company ?? "BF");
    const retryUrl = `${BASE}/intent?company=${encodeURIComponent(company)}&retry=1`;
    const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action: retryUrl, method: "POST" });
    emit(g, "intent_retry", PHRASES.intent_retry);
    v.redirect({ method: "POST" }, retryUrl);
    return send(res, v);
  }
  if (!target) target = "engagement";
  if (target === "engagement") {
    const todd = await resolveTarget("sales");
    const andrew = await resolveTarget("underwriting");
    const others = await readyStaffIdentities(andrew.userId);
    const identities = Array.from(new Set([...(todd.clientReady && todd.identity ? [todd.identity] : []), ...others])).slice(0, 10);
    const callerId = String((req.body?.From ?? "")).trim() || config.twilio.callerId || config.twilio.from || config.twilio.number || undefined;
    if (identities.length > 0) {
      emit(v, "connect_engagement", PHRASES.connect_engagement);
      const dial = v.dial({ answerOnBridge: true, timeout: 25, action: `${BASE}/unavailable?target=engagement`, method: "POST", callerId });
      for (const identity of identities) dial.client(identity);
      return send(res, v);
    }
    if (todd.standaloneWatch && todd.cell) {
      emit(v, "connect_engagement", PHRASES.connect_engagement);
      const dial = v.dial({ answerOnBridge: true, timeout: 25, action: `${BASE}/unavailable?target=engagement`, method: "POST", callerId });
      dial.number(todd.cell);
      return send(res, v);
    }
    offerMessageOrVoicemail(v, "engagement_unavail", PHRASES.engagement_unavail, null);
    return send(res, v);
  }
  const t = await resolveTarget(target);
  const name = displayFor(target);
  // BF_SERVER_RECEPTION_SIMRING_v1 — ring the softphone only when its heartbeat
  // is fresh (a stale "available" row was dialing a dead WebRTC client -> 0-sec
  // no-answer).
  // BF_SERVER_PHONE_HOTFIX_v1 - forward the ORIGINAL caller's number so staff see who
  // is calling (Twilio allows the inbound caller's number as callerId when forwarding).
  const callerId = String((req.body?.From ?? "")).trim() || config.twilio.callerId || config.twilio.from || config.twilio.number || undefined;
  // Never parallel-dial cellular: a reachable iPhone/portal remains authoritative.
  // The explicitly enabled standalone Watch fallback below is sequential only.
  if (t.clientReady && t.identity) {
    emit(v, `connect_${lkey(target)}`, `One moment, connecting you to ${name}.`);
    const dial = v.dial({ answerOnBridge: true, timeout: 25, action: `${BASE}/unavailable?target=${target}`, method: "POST", callerId });
    dial.client(t.identity);
    return send(res, v);
  }
  // The established, reachable Boreal VoIP client always wins. Cellular
  // forwarding is only a fallback when an owned Watch explicitly opted in and
  // the staff callback number is server-verified.
  if (t.standaloneWatch && t.cell) {
    emit(v, `connect_${lkey(target)}`, `One moment, connecting you to ${name}.`);
    const dial = v.dial({ answerOnBridge: true, timeout: 25, action: `${BASE}/unavailable?target=${target}`, method: "POST", callerId });
    dial.number(t.cell);
    return send(res, v);
  }
  const reasonKey = t.onCall ? `reason_${lkey(target)}_oncall` : `reason_${lkey(target)}_unavail`;
  const reasonText = `Sorry, ${name} ${t.onCall ? "is on another call" : "isn't available right now"}.`;
  offerMessageOrVoicemail(v, reasonKey, reasonText, t.userId);
  return send(res, v);
});

router.post("/unavailable", twilioWebhookValidation, async (req: Request, res: Response) => {
  if (String(req.query.target || "") === "engagement") {
    const v = await newVR();
    if (String(req.body?.DialCallStatus ?? "") === "completed") { v.hangup(); return send(res, v); }
    offerMessageOrVoicemail(v, "engagement_noanswer", PHRASES.engagement_noanswer, null);
    return send(res, v);
  }
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

// BF_SERVER_DIRECT_LINES_v688 - nobody answered a direct line: that person's own voicemail.
router.post("/direct-unavailable", twilioWebhookValidation, async (req: Request, res: Response) => {
  const v = await newVR();
  if (String(req.body?.DialCallStatus ?? "") === "completed") return send(res, v);
  const userId = String(req.query.user ?? "").trim() || null;
  let name = "The person you called";
  if (userId) {
    try {
      const r = await pool.query<{ first_name: string | null }>(`SELECT first_name FROM users WHERE id::text = $1 LIMIT 1`, [userId]);
      if (r.rows[0]?.first_name) name = String(r.rows[0].first_name);
    } catch (err: any) {
      console.warn("[reception] direct line name lookup failed", { message: err?.message });
    }
  }
  offerMessageOrVoicemail(v, "direct_noanswer", `Sorry, ${name} isn't available right now.`, userId);
  return send(res, v);
});

if (novaOn()) { void warmReceptionVoice(); }

export default router;
