// BF_SERVER_RECEPTION_v1 (+ NOVA_VOICE_v1) — Maya phone receptionist on the 866 main line.
// BF_SERVER_v869_PHONE_MENU - what callers hear and where each choice goes is now the phone menu in Settings
// (src/phoneMenu/menu.ts, ported from KS-server #38). With no menu saved it is defaultBorealMenu(), which is exactly
// the menu callers heard before: Financial (1: client engagement rings Todd plus every other free staff member except
// Andrew; 2: credit rings Andrew), Risk Management (Todd), 3: a scheduled meeting. People ring on their apps only when
// genuinely available (presence = hours + on-call + in-meeting + manual), then their opted-in Watch cell; every dead
// end records a voicemail.
//
// Voice: defaults to Polly. When RECEPTION_NOVA_VOICE=true, every line is
// played from Maya's nova voice via the key-gated /voice endpoint below
// (rendered once, cached, warmed at boot). If OpenAI is unreachable the flag
// can simply be turned off to revert to Polly with no redeploy.
import express, { Router, type Request, type Response } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { pool } from "../db.js";
import { ringableStaffSql } from "../modules/presence/presenceService.js"; // BF_SERVER_v817_DIALER_MESSAGING
import { config } from "../config/index.js";
import { sharedOpenAI } from "../lib/sharedClients.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS // BF_SERVER_SNAT_REUSE_v784
// BF_SERVER_v820_WATCH_CALLS - app first, then the verified cell (screened), for staff who opted in.
import {
  CELL_RING_TIMEOUT_SECONDS, CLIENT_FIRST_TIMEOUT_SECONDS, SCREEN_GATHER_TIMEOUT_SECONDS,
  callerHungUp, callerLabel, dialWasNotAnswered, screenUrl, verifiedWatchCell,
} from "../voice/watchCellFallback.js";
import { alertMissedCall } from "../services/notifications/staffAlertEvents.js";
// BF_SERVER_v821_DIALER - caller card on the <Client>, recording of bridged calls, do-not-disturb by hours.
import { callerCardForCall, dialClient, type CallerCard } from "../voice/callerCard.js";
import {
  RECORDING_NOTICE, closeCallRecord, inboundRecordName, legStatusAttrs, recordLegStatus, recordingDialAttrs,
} from "../voice/recordedDial.js";
import { awayStatus, identitiesOutsideHours } from "../voice/callHours.js";
import { awayTwiml, openInboundRecord, ringDirectLine, staffVoicemail } from "../voice/staffRing.js";
// BF_SERVER_v869_PHONE_MENU / BF_SERVER_v869_BLOCKED_NUMBERS
import { DEFAULT_RING_SECONDS, allOptions, chooseOption, findOption, isRoleRef, officeOpen, optionsPrompt, promptText, type MenuOption, type MenuTarget, type PhoneMenu, type Prompt } from "../phoneMenu/menu.js";
import { loadMenu, readAudio } from "../phoneMenu/store.js";
import { handleBlockedCall } from "../voice/blockedNumbers.js";

const router = Router();

// Twilio webhooks post application/x-www-form-urlencoded payloads, and the
// signature validator needs the parsed params to validate the request.
router.use(express.urlencoded({ extended: false }));

const VOICE = "Polly.Joanna";
const BASE = "/api/webhooks/twilio/reception";

const PHRASES: Record<string, string> = {
  // BF_SERVER_RECEPTION_MENU_v698 - wording approved by Todd 2026-10-01.
  greeting: "This call may be recorded. Thank you for calling the Boreal Group of Companies. Are you looking for Boreal Financial, or Boreal Risk Management? You can say it, or press 1 for Financial, 2 for Risk Management. To join a scheduled meeting, press 3.",
  // BF_SERVER_MEETING_ROOMS_v736 - option 3: join a conference room with its access code.
  meeting_prompt: "Please enter your six digit meeting access code, then press pound.",
  meeting_retry: "Sorry, that code isn't valid for a meeting happening now. Please enter your six digit access code, then press pound.",
  meeting_joining: "Thank you. Joining your meeting now.",
  meeting_failed: "Sorry, we couldn't find a meeting with that code. Please check the code in your invitation and call back, or stay on the line to reach our team.",
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
  // BF_SERVER_v869_PHONE_MENU - lines a saved menu can use.
  menu_retry: "Sorry, I didn't catch that.",
  connecting: "One moment, connecting you.",
  ai_prompt: "In a few words, what is your call about?",
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
    const client = sharedOpenAI(apiKey);
    // BF_SERVER_v817_AUDIO_MODELS - model from OPENAI_TTS_MODEL, falling back to tts-1.
    const { ttsModel, LEGACY_TTS_MODEL, withAudioModelFallback } = await import("../lib/openaiAudioModels.js");
    const speech = await withAudioModelFallback(ttsModel(), LEGACY_TTS_MODEL,
      (model) => client.audio.speech.create({ model, voice: "nova", input: text }), "reception_nova");
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

// BF_SERVER_v869_PHONE_MENU - text from the menu, played in the nova voice when it is one of the rendered phrases
// above (the default menu's words all are), else read by Polly. A text made of several phrases plays each in turn.
function emitText(node: any, text: string): void {
  const t = String(text ?? "").trim();
  if (!t) return;
  const whole = Object.keys(PHRASES).find((k) => PHRASES[k] === t);
  if (whole) { emit(node, whole, t); return; }
  const parts: string[] = [];
  let rest = t;
  while (rest) {
    const k = Object.keys(PHRASES).find((key) => rest.startsWith(PHRASES[key]!) && (rest.length === PHRASES[key]!.length || rest[PHRASES[key]!.length] === " "));
    if (!k) { node.say({ voice: VOICE }, t); return; }
    parts.push(k);
    rest = rest.slice(PHRASES[k]!.length).trimStart();
  }
  for (const k of parts) emit(node, k, PHRASES[k]!);
}

/** A menu prompt: the uploaded recording (then any announced options), or the text read aloud. */
function speak(node: any, prompt: Prompt, text: string): void {
  if (prompt.mode === "audio" && prompt.audioId) {
    node.play(`${BASE}/audio/${encodeURIComponent(prompt.audioId)}`);
    if (text) node.say({ voice: VOICE }, text);
    return;
  }
  emitText(node, text);
}

function speech(req: Request): string { return String((req.body?.SpeechResult ?? "") as string).toLowerCase(); }
function digit(req: Request): string { return String((req.body?.Digits ?? "") as string).trim(); }
async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response { res.setHeader("Content-Type", "text/xml"); return res.send(v.toString()); }

// BF_SERVER_v831_DIALER_POLISH - who each reception role rings (the default menu's @sales / @underwriting).
export function receptionFirstName(t: "sales" | "underwriting" | "engagement"): string { return t === "sales" ? "todd" : "andrew"; }
export function receptionUserId(t: "sales" | "underwriting" | "engagement"): string | null {
  const raw = t === "sales" ? process.env.RECEPTION_SALES_USER_ID : process.env.RECEPTION_UNDERWRITING_USER_ID;
  const id = String(raw ?? "").trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (/^\+\d{10,15}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

type Resolved = { identity: string | null; available: boolean; onCall: boolean; clientReady: boolean; cell: string | null; standaloneWatch: boolean; userId: string | null };
const NOBODY: Resolved = { identity: null, available: false, onCall: false, clientReady: false, cell: null, standaloneWatch: false, userId: null };

/** A person in the menu: a user id, or a reception role (@sales / @underwriting) resolved the way it always was. */
async function resolveTarget(ref: string): Promise<Resolved> {
  // BF_SERVER_v831_DIALER_POLISH - an exact first name, active users only, or the user id in
  // RECEPTION_SALES_USER_ID / RECEPTION_UNDERWRITING_USER_ID when set (never ILIKE '%todd%').
  const role = ref === "@sales" ? "sales" : ref === "@underwriting" ? "underwriting" : null;
  const nameLike = role ? receptionFirstName(role) : "";
  const pinnedId = role ? receptionUserId(role) : (/^[0-9a-f-]{36}$/i.test(ref) ? ref : null);
  if (!role && !pinnedId) return NOBODY;
  try {
    const { rows } = await pool.query<{ status: string; twilio_identity: string | null; on_call: boolean; fresh: boolean; ringable: boolean; phone: string | null; standalone_watch: boolean; user_id: string | null }>(
      `SELECT sp.status, sp.twilio_identity, coalesce(sp.on_call, false) AS on_call, u.id AS user_id,
              ((sp.last_heartbeat > now() - interval '90 seconds') OR EXISTS (
                SELECT 1 FROM staff_device_credentials dc WHERE dc.user_id = u.id AND dc.revoked_at IS NULL
                  AND dc.expires_at > now())) AS fresh, -- BF_SERVER_PHONE_ROUTING_v688b: signed in on the dialler app counts
              -- BF_SERVER_v817_DIALER_MESSAGING - ringable even when the closed iOS app stopped heartbeating
              ${ringableStaffSql("sp", "u")} AS ringable,
              u.verified_callback_number AS phone,
              (u.callback_verified_at IS NOT NULL AND EXISTS (
                SELECT 1 FROM watch_devices wd WHERE wd.staff_user_id=u.id AND wd.revoked_at IS NULL
                  AND wd.standalone_routing_enabled=true)) AS standalone_watch
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE (u.first_name ILIKE $1 OR u.id::text = $2) AND ($2::text IS NULL OR u.id::text = $2)
          AND coalesce(u.active, true) = true
        ORDER BY sp.last_heartbeat DESC NULLS LAST LIMIT 1`,
      [nameLike, pinnedId],
    );
    const r = rows[0];
    if (!r) return NOBODY;
    // BF_SERVER_v817_DIALER_MESSAGING - a closed iOS app (stale heartbeat -> 'offline') still receives VoIP pushes.
    const clientReady = (r.status === "available" && !!r.twilio_identity && !!r.fresh) || (!!r.ringable && !!r.twilio_identity);
    return { identity: r.twilio_identity, available: r.status === "available" && !!r.twilio_identity, onCall: !!r.on_call, clientReady, cell: toE164(r.phone), standaloneWatch: !!r.standalone_watch, userId: r.user_id ?? null };
  } catch (err: any) {
    console.warn("[reception] person lookup failed", { message: err?.message });
    return NOBODY;
  }
}

// Every signed-in, free staff member except the listed people (the default menu: except Andrew), for a group that
// rings "everyone else who is available".
async function readyStaffIdentities(exceptIds: string[], exceptUnderwritingByName: boolean): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ twilio_identity: string }>(
      `SELECT DISTINCT sp.twilio_identity
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        -- BF_SERVER_v817_DIALER_MESSAGING - ringable (registered identity, not busy / on a call /
        -- in a meeting) instead of status = 'available', which excluded every closed iOS dialler.
        WHERE ${ringableStaffSql("sp", "u")}
          AND coalesce(u.active, true) = true
          AND NOT (u.id::text = ANY($1::text[]))
          AND NOT ($3::boolean AND (CASE WHEN $2::text IS NOT NULL THEN u.id::text = $2 ELSE coalesce(u.first_name, '') ILIKE 'andrew' END))
        LIMIT 9`,
      [exceptIds, receptionUserId("underwriting"), exceptUnderwritingByName],
    );
    return rows.map((r) => r.twilio_identity).filter(Boolean);
  } catch (err: any) {
    console.warn("[reception] ready staff lookup failed", { message: err?.message });
    return [];
  }
}

function offerMessageOrVoicemail(v: any, openerText: string, staffUserId?: string | null): void {
  // BF_SERVER_RECEPTION_VOICEMAIL_ONLY_v1 — no "take a message vs voicemail" choice; play the opener, then go
  // straight to recording a voicemail.
  emitText(v, openerText);
  emit(v, "record_prompt", PHRASES.record_prompt);
  // BF_SERVER_PHONE_HOTFIX_v1 - a voicemail for a specific person is stamped with their id so it stays private to them.
  const action = staffUserId ? `/api/webhooks/twilio/voicemail?staff=${encodeURIComponent(staffUserId)}` : "/api/webhooks/twilio/voicemail";
  v.record({ maxLength: 120, playBeep: true, action });
}

// BF_SERVER_v820_WATCH_CALLS - the cell leg: a screened <Number> so the person presses 1 to take the call. Their
// cell's own voicemail cannot press 1, so an unanswered cell hangs up the leg and the caller reaches Boreal voicemail.
function dialCell(v: any, cell: string, action: string, callerId: string | undefined, from: string, rec: string | null = null, identity: string | null = null): void {
  const dial = v.dial({ answerOnBridge: true, timeout: CELL_RING_TIMEOUT_SECONDS, action, method: "POST", callerId, ...recordingDialAttrs(rec) });
  dial.number({ url: screenUrl(from), method: "POST", ...legStatusAttrs(rec, identity) }, cell);
}

// BF_SERVER_v829_DIALER_RELIABILITY - rx_<parent CallSid> carries the caller's sid for the leg status callback.
function legRecordName(req: Request): string | null {
  const callSid = String(req.body?.CallSid ?? "").trim();
  return callSid ? inboundRecordName(callSid) : null;
}

function callerFrom(req: Request): string { return String((req.body?.From ?? "")).trim(); }
function callerIdFor(req: Request): string | undefined {
  return callerFrom(req) || config.twilio.callerId || config.twilio.from || config.twilio.number || undefined;
}

// BF_SERVER_v820_WATCH_CALLS - a caller that ends at voicemail without anyone answering is a missed call: alert the
// person it was for (everyone for a group). Never delays the TwiML.
function missedCall(req: Request, staffUserId: string | null): void {
  void alertMissedCall({ from: callerFrom(req) || null, staffUserId, silo: "BF", callSid: String(req.body?.CallSid ?? "") || null });
  closeRecord(req); // BF_SERVER_v821_DIALER
}

// BF_SERVER_v821_DIALER - the inbound call record (rx_<parent CallSid>) is over once the call ends unanswered.
function closeRecord(req: Request): void {
  const callSid = String(req.body?.CallSid ?? "").trim();
  if (callSid) void closeCallRecord(pool, inboundRecordName(callSid));
}

// BF_SERVER_v821_DIALER - caller card + call record for a call about to ring staff.
async function cardAndRecord(req: Request): Promise<{ card: CallerCard | null; rec: string | null }> {
  const card = await callerCardForCall(pool, callerFrom(req));
  const rec = await openInboundRecord(pool, { callSid: String(req.body?.CallSid ?? ""), from: callerFrom(req), card });
  return { card, rec };
}

router.get("/voice", safeHandler(async (req: Request, res: Response) => {
  const key = String(req.query.key || "");
  const text = PHRASES[key];
  if (!text) return res.status(404).end();
  let buf = audioCache.get(key);
  if (!buf) {
    // BF_SERVER_RECEPTION_VOICE_FALLBACK_v40 - emit() never points a live call at an unrendered key.
    const rendered = await renderNova(text);
    if (!rendered) return res.status(503).end();
    audioCache.set(key, rendered);
    buf = rendered;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.send(buf);
}));

// BF_SERVER_v869_PHONE_MENU - an uploaded greeting, fetched by Twilio's <Play> (ids are random UUIDs).
router.get("/audio/:id", safeHandler(async (req: Request, res: Response) => {
  const audio = await readAudio(pool, String(req.params.id ?? ""));
  if (!audio) return res.status(404).end();
  res.setHeader("Content-Type", audio.content_type);
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(audio.bytes);
}));

// ------------------------------------------------------------------ routing a caller to a menu target
type RouteCtx = {
  /** The option id (or "after" / "noanswer") the target came from: carried in callback URLs. */
  ref: string;
  /** What the option is called ("client engagement"), for "connecting you to our ... team". */
  label: string;
  /** true while the menu's no-answer fallback is running: unanswered then ends at voicemail (no loops). */
  fallback: boolean;
  /** The person rung before the fallback (their voicemail is where the fallback ends). */
  forUserId: string | null;
};

const ctxQuery = (ctx: RouteCtx): string =>
  `${ctx.fallback ? "&fb=1" : ""}${ctx.forUserId ? `&for=${encodeURIComponent(ctx.forUserId)}` : ""}`;

function ctxFrom(req: Request, ref: string, label: string): RouteCtx {
  const forId = String(req.query.for ?? "").trim();
  return { ref, label, fallback: String(req.query.fb ?? "") === "1", forUserId: /^[0-9a-f-]{36}$/i.test(forId) ? forId : null };
}

/** The target a callback's ref points at in the current menu. */
function targetForRef(menu: PhoneMenu, ref: string): { target: MenuTarget; label: string } | null {
  if (ref === "after") return { target: menu.afterHours, label: "" };
  if (ref === "noanswer") return { target: menu.noAnswer.target, label: "" };
  const o = findOption(menu, ref);
  return o ? { target: o.target, label: o.label } : null;
}

/** Nobody picked up (or nobody could be rung). The default menu: the person's own voicemail (the shared one for a
 *  group), with the sorry line. A saved menu may send it on once to someone else first. */
async function noAnswer(v: any, req: Request, menu: PhoneMenu, ctx: RouteCtx, sorry: string, whoUserId: string | null): Promise<void> {
  const fallback = menu.noAnswer?.target ?? { type: "voicemail", userId: null, message: "" };
  if (ctx.fallback || fallback.type === "voicemail") {
    const box = ctx.fallback ? (ctx.forUserId ?? whoUserId) : (fallback.type === "voicemail" && fallback.userId ? fallback.userId : whoUserId);
    missedCall(req, box);
    offerMessageOrVoicemail(v, [sorry, fallback.type === "voicemail" && !ctx.fallback ? fallback.message : ""].filter(Boolean).join(" "), box);
    return;
  }
  emitText(v, sorry);
  await routeTarget(v, req, menu, fallback, { ref: "noanswer", label: "", fallback: true, forUserId: whoUserId });
}

function groupSorry(kind: "unavail" | "noanswer"): string {
  return kind === "unavail" ? PHRASES.engagement_unavail! : PHRASES.engagement_noanswer!;
}

/** Builds the TwiML that sends the caller to a menu target. */
async function routeTarget(v: any, req: Request, menu: PhoneMenu, target: MenuTarget, ctx: RouteCtx): Promise<void> {
  const ringSeconds = menu.noAnswer?.ringSeconds ?? DEFAULT_RING_SECONDS;
  if (target.type === "voicemail") {
    // A voicemail chosen in the menu (Caden, "where are you") is not a missed call; one reached as a fallback is.
    const box = target.userId ?? ctx.forUserId;
    if (ctx.fallback) missedCall(req, box);
    offerMessageOrVoicemail(v, target.message, box);
    return;
  }
  if (target.type === "meeting") { v.redirect({ method: "POST" }, `${BASE}/meeting`); return; }
  if (target.type === "ai") {
    const action = `${BASE}/ai?ref=${encodeURIComponent(ctx.ref)}${ctxQuery(ctx)}`;
    const g = v.gather({ input: "speech", speechTimeout: "auto", timeout: 6, action, method: "POST" });
    emit(g, "ai_prompt", PHRASES.ai_prompt);
    v.redirect({ method: "POST" }, action);
    return;
  }
  if (target.type === "submenu") {
    const action = `${BASE}/intent?company=${encodeURIComponent(ctx.ref)}`;
    const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action, method: "POST" });
    speak(g, target.menu.prompt, promptText(target.menu.prompt, target.menu.options, target.menu.announceOptions));
    v.redirect({ method: "POST" }, action);
    return;
  }
  if (target.type === "user") {
    const t = await resolveTarget(target.userId);
    // BF_SERVER_v821_DIALER - outside the person's call hours: away prompt (press 1 rings them as normal).
    const away = await awayStatus(pool, t.userId);
    if (away.away && t.userId) {
      awayTwiml(v, { name: target.name, userId: t.userId, urgentPassthrough: away.urgentPassthrough, ring: ctx.ref });
      return;
    }
    await ringNamedTarget(v, req, menu, target, t, ctx);
    return;
  }
  // group
  const listed = await Promise.all(target.userIds.map((ref) => resolveTarget(ref)));
  const lead = listed[0] ?? NOBODY;
  const callerId = callerIdFor(req);
  const connect = ctx.label ? `One moment, connecting you to our ${ctx.label} team.` : PHRASES.connecting!;
  if (target.strategy === "sequential") {
    const ready = await readyInOrder(target.userIds);
    const first = ready[0];
    if (!first) { await noAnswer(v, req, menu, ctx, groupSorry("unavail"), null); return; }
    const { card, rec } = await cardAndRecord(req);
    emitText(v, connect);
    const action = `${BASE}/group-next?target=${encodeURIComponent(ctx.ref)}&after=${encodeURIComponent(first.ref)}${ctxQuery(ctx)}`;
    const dial = v.dial({ answerOnBridge: true, timeout: ringSeconds, action, method: "POST", callerId, ...recordingDialAttrs(rec) });
    dialClient(dial, first.identity, card, legStatusAttrs(rec ?? legRecordName(req), first.identity));
    return;
  }
  const exceptRefs = target.exceptUserIds;
  const exceptIds = (await Promise.all(exceptRefs.filter((r) => !isRoleRef(r) || r !== "@underwriting").map((r) => resolveTarget(r))))
    .map((x) => x.userId).filter((x): x is string => Boolean(x));
  const underwriting = exceptRefs.includes("@underwriting") ? await resolveTarget("@underwriting") : null;
  if (underwriting?.userId) exceptIds.push(underwriting.userId);
  const others = target.everyoneAvailable ? await readyStaffIdentities(exceptIds, Boolean(underwriting)) : [];
  const listedReady = listed.filter((p) => p.clientReady && p.identity && !exceptIds.includes(String(p.userId))).map((p) => p.identity!);
  const everyone = Array.from(new Set([...listedReady, ...others])).slice(0, 10);
  // BF_SERVER_v821_DIALER - a group member outside their call hours is skipped (no prompt for a group ring).
  const awayIds = await identitiesOutsideHours(pool, everyone);
  const identities = everyone.filter((identity) => !awayIds.has(identity));
  const leadAway = (await awayStatus(pool, lead.userId)).away;
  // BF_SERVER_v820_WATCH_CALLS - with the first listed person's Watch fallback on, the apps ring for 15 s, then their
  // cell (screened).
  const leadCell = !leadAway && lead.standaloneWatch && lead.cell ? lead.cell : null;
  if (identities.length > 0) {
    const { card, rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER
    emitText(v, connect);
    const action = `${BASE}/unavailable?target=${encodeURIComponent(ctx.ref)}${leadCell ? "&cell=1" : ""}${ctxQuery(ctx)}`;
    const dial = v.dial({ answerOnBridge: true, timeout: leadCell ? CLIENT_FIRST_TIMEOUT_SECONDS : ringSeconds, action, method: "POST", callerId, ...recordingDialAttrs(rec) });
    for (const identity of identities) dialClient(dial, identity, card, legStatusAttrs(rec ?? legRecordName(req), identity)); // BF_SERVER_v829_DIALER_RELIABILITY
    return;
  }
  if (leadCell) {
    const { rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER
    emitText(v, connect);
    dialCell(v, leadCell, `${BASE}/unavailable?target=${encodeURIComponent(ctx.ref)}${ctxQuery(ctx)}`, callerId, callerFrom(req), rec, lead.userId);
    return;
  }
  await noAnswer(v, req, menu, ctx, groupSorry("unavail"), null);
}

/** The listed people of a one-at-a-time group who can ring now, in order, skipping anyone outside their call hours. */
async function readyInOrder(refs: string[]): Promise<Array<{ ref: string; identity: string; userId: string | null }>> {
  const people = await Promise.all(refs.map(async (ref) => ({ ref, r: await resolveTarget(ref) })));
  const ready = people.filter((p) => p.r.clientReady && p.r.identity).map((p) => ({ ref: p.ref, identity: p.r.identity!, userId: p.r.userId }));
  const away = await identitiesOutsideHours(pool, ready.map((p) => p.identity));
  return ready.filter((p) => !away.has(p.identity));
}

// BF_SERVER_v821_DIALER - one person's ring, shared by the menu and the away prompt's press-1.
async function ringNamedTarget(v: any, req: Request, menu: PhoneMenu, target: { name: string }, t: Resolved, ctx: RouteCtx): Promise<void> {
  const name = target.name;
  // BF_SERVER_PHONE_HOTFIX_v1 - forward the ORIGINAL caller's number so staff see who is calling.
  const callerId = callerIdFor(req);
  // Never parallel-dial cellular: a reachable iPhone/portal rings first and on its own.
  // BF_SERVER_v820_WATCH_CALLS - the explicitly enabled standalone Watch fallback (server-verified cell + an
  // opted-in Watch) is SEQUENTIAL: the app rings for 15 s, then /unavailable?cell=1 rings the cell, screened.
  const watchCell = t.standaloneWatch && t.cell ? t.cell : null;
  if (t.clientReady && t.identity) {
    const { card, rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER
    emitText(v, `One moment, connecting you to ${name}.`);
    const action = `${BASE}/unavailable?target=${encodeURIComponent(ctx.ref)}${watchCell ? "&cell=1" : ""}${ctxQuery(ctx)}`;
    const dial = v.dial({ answerOnBridge: true, timeout: watchCell ? CLIENT_FIRST_TIMEOUT_SECONDS : (menu.noAnswer?.ringSeconds ?? DEFAULT_RING_SECONDS), action, method: "POST", callerId, ...recordingDialAttrs(rec) });
    dialClient(dial, t.identity, card, legStatusAttrs(rec ?? legRecordName(req), t.identity)); // BF_SERVER_v829_DIALER_RELIABILITY
    return;
  }
  // No reachable app: the opted-in cell (screened) is the only leg.
  if (watchCell) {
    const { rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER
    emitText(v, `One moment, connecting you to ${name}.`);
    dialCell(v, watchCell, `${BASE}/unavailable?target=${encodeURIComponent(ctx.ref)}${ctxQuery(ctx)}`, callerId, callerFrom(req), rec, t.userId);
    return;
  }
  await noAnswer(v, req, menu, ctx, `Sorry, ${name} ${t.onCall ? "is on another call" : "isn't available right now"}.`, t.userId);
}

// ------------------------------------------------------------------ the greeting and the menu choices
// BF_SERVER_v827_CONFERENCE_DIAL - the greeting takes up to 8 keys ending with # (or a 3-second pause), so the meeting
// key followed straight away by the access code joins the meeting in one step. A single key still works as before.
router.post("/greeting", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const again = String(req.query.again ?? "") === "1";
  // BF_SERVER_v869_BLOCKED_NUMBERS - also here, for a number pointed straight at the menu.
  if (!again && await handleBlockedCall(pool as any, v, callerFrom(req), String(req.body?.CallSid ?? "") || null)) return send(res, v);
  const { menu } = await loadMenu(pool as any);
  const status = officeOpen(menu, new Date());
  if (!status.open) {
    console.log(JSON.stringify({ event: "phone_menu_closed", callSid: req.body?.CallSid ?? null, holiday: status.holiday }));
    speak(v, menu.afterHoursGreeting, promptText(menu.afterHoursGreeting, [], false));
    await routeTarget(v, req, menu, menu.afterHours, { ref: "after", label: "", fallback: false, forUserId: null });
    return send(res, v);
  }
  const action = `${BASE}/company${again ? "?again=1" : ""}`;
  const g = v.gather({ input: "speech dtmf", numDigits: 8, finishOnKey: "#", speechTimeout: "auto", timeout: 3, action, method: "POST" });
  speak(g, menu.greeting, promptText(menu.greeting, menu.options, menu.announceOptions));
  v.redirect({ method: "POST" }, action);
  return send(res, v);
}));

/** BF_SERVER_v827_CONFERENCE_DIAL - speech that is really the greeting heard back (speakerphone echo), not an answer. */
export function looksLikeEcho(speechText: string): boolean {
  const s = String(speechText ?? "").toLowerCase();
  if (!s) return false;
  return /\bpress\b|scheduled|you can say|this call may be recorded|group of companies|thank you for calling/.test(s) || s.split(/\s+/).filter(Boolean).length > 6;
}

router.post("/company", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const { menu } = await loadMenu(pool as any);
  const raw = digit(req).replace(/[^0-9]/g, "");
  const d = raw.slice(0, 1);
  let s = speech(req);
  const again = String(req.query.again ?? "") === "1";
  // BF_SERVER_v827_CONFERENCE_DIAL - the greeting heard back through a speakerphone is not an answer: play it once more
  // (then carry on as if nothing was chosen), instead of acting on words in the echo.
  if (!raw && looksLikeEcho(s)) {
    console.log(JSON.stringify({ event: "reception_echo_ignored", callSid: req.body?.CallSid ?? null, speech: s }));
    if (!again) { const ve = await newVR(); ve.redirect({ method: "POST" }, `${BASE}/greeting?again=1`); return send(res, ve); }
    s = "";
  }
  const v = await newVR();
  // The meeting key + the six-digit code in one go: join that meeting straight away.
  const keyed = d ? menu.options.find((o) => o.digit === d) : undefined;
  if (keyed?.target.type === "meeting" && raw.length === 7) { v.redirect({ method: "POST" }, `${BASE}/meeting-code?try=0&code=${raw.slice(1)}`); return send(res, v); }
  let option = chooseOption(menu.options, d, s);
  console.log(JSON.stringify({ event: "phone_menu_choice", callSid: req.body?.CallSid ?? null, digits: raw || null, speech: s || null, option: option?.id ?? null, again }));
  if (!option && menu.whenNoChoice.retry && !again) {
    emit(v, "menu_retry", PHRASES.menu_retry);
    v.redirect({ method: "POST" }, `${BASE}/greeting?again=1`);
    return send(res, v);
  }
  if (!option && menu.whenNoChoice.optionId) option = menu.options.find((o) => o.id === menu.whenNoChoice.optionId) ?? null;
  if (!option) { await noAnswer(v, req, menu, { ref: "noanswer", label: "", fallback: false, forUserId: null }, groupSorry("unavail"), null); return send(res, v); }
  await routeTarget(v, req, menu, option.target, { ref: option.id, label: option.label, fallback: false, forUserId: null });
  return send(res, v);
}));

// BF_SERVER_MEETING_ROOMS_v736 - ask for the access code (two tries), then drop the caller
// into that meeting's conference. Staff join the same way, from any phone or the dialler.
router.post("/meeting", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const tries = Number(req.query.try ?? 0) || 0;
  const g = v.gather({ input: "dtmf", numDigits: 6, finishOnKey: "#", timeout: 10, action: `${BASE}/meeting-code?try=${tries}`, method: "POST" });
  emit(g, tries > 0 ? "meeting_retry" : "meeting_prompt", tries > 0 ? PHRASES.meeting_retry : PHRASES.meeting_prompt);
  v.redirect({ method: "POST" }, `${BASE}/meeting-code?try=${tries}`);
  return send(res, v);
}));

router.post("/meeting-code", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const tries = Number(req.query.try ?? 0) || 0;
  const { findOpenRoomByCode, conferenceName, roomConferenceAttrs } = await import("../services/meetingRooms.js");
  // BF_SERVER_v827_CONFERENCE_DIAL - the code can come from the greeting (meeting key + code) as ?code=.
  const entered = typeof req.query.code === "string" && /^[0-9]{6}$/.test(req.query.code) ? req.query.code : digit(req);
  const room = await findOpenRoomByCode(entered).catch((err: unknown) => {
    console.error("[meeting] code lookup failed", err instanceof Error ? err.message : String(err));
    return null;
  });
  console.log(JSON.stringify({ event: "meeting_code", callSid: req.body?.CallSid ?? null, matched: Boolean(room), try: tries }));
  if (room) {
    emit(v, "meeting_joining", PHRASES.meeting_joining);
    const dial = v.dial();
    // BF_SERVER_v786_ROOM_RECORDINGS - status + recording callbacks so the room is recorded into the CRM.
    dial.conference(roomConferenceAttrs(room.id, String(req.body?.From ?? req.body?.Caller ?? "") || null) as any, conferenceName(room.id));
    return send(res, v);
  }
  if (tries < 1) { v.redirect({ method: "POST" }, `${BASE}/meeting?try=${tries + 1}`); return send(res, v); }
  emit(v, "meeting_failed", PHRASES.meeting_failed);
  // Then on as if nothing was chosen at the greeting (the default menu: Boreal Financial).
  const { menu } = await loadMenu(pool as any);
  v.redirect({ method: "POST" }, `${BASE}/intent?company=${encodeURIComponent(menu.whenNoChoice.optionId ?? "BF")}`);
  return send(res, v);
}));

// A second menu (Boreal Financial: client engagement / credit). company = the option that opened it. Calls still
// in progress when this version deployed may post company=BRM: that was Risk Management (Todd).
router.post("/intent", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const { menu } = await loadMenu(pool as any);
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  const company = String(req.query.company ?? "");
  const parent = findOption(menu, company === "BRM" && !findOption(menu, "BRM") ? "sales" : company)
    ?? menu.options.find((o) => o.id === menu.whenNoChoice.optionId) ?? null;
  if (!parent) { await noAnswer(v, req, menu, { ref: "noanswer", label: "", fallback: false, forUserId: null }, groupSorry("unavail"), null); return send(res, v); }
  if (parent.target.type !== "submenu") {
    await routeTarget(v, req, menu, parent.target, { ref: parent.id, label: parent.label, fallback: false, forUserId: null });
    return send(res, v);
  }
  const sub = parent.target.menu;
  const retry = String(req.query.retry ?? "") === "1";
  let choice = chooseOption(sub.options, d, s);
  // BF_SERVER_VOICE_AUDIT_v686 - retain the caller's attempted response in logs, then give an unclear caller one
  // explicit keypad retry.
  console.log(JSON.stringify({ event: "reception_intent", callSid: req.body?.CallSid ?? null, speech: s || null, digits: d || null, target: choice?.id ?? null, retry }));
  if (!choice && sub.whenNoChoice.retry && !retry) {
    const retryUrl = `${BASE}/intent?company=${encodeURIComponent(parent.id)}&retry=1`;
    const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action: retryUrl, method: "POST" });
    emitText(g, sub.retryPrompt || [PHRASES.menu_retry, optionsPrompt(sub.options)].join(" "));
    v.redirect({ method: "POST" }, retryUrl);
    return send(res, v);
  }
  if (!choice && sub.whenNoChoice.optionId) choice = sub.options.find((o) => o.id === sub.whenNoChoice.optionId) ?? null;
  if (!choice) { await noAnswer(v, req, menu, { ref: "noanswer", label: "", fallback: false, forUserId: null }, groupSorry("unavail"), null); return send(res, v); }
  await routeTarget(v, req, menu, choice.target, { ref: choice.id, label: choice.label, fallback: false, forUserId: null });
  return send(res, v);
}));

// A person or group <Dial> ended. Answered: hang up. Unanswered: the opted-in cell once (cell=1), then no-answer.
router.post("/unavailable", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  // BF_SERVER_v820_WATCH_CALLS - cell=1: the app leg was the first of two. Unanswered (no-answer / busy / failed)
  // and the caller still on the line -> ring the opted-in cell, screened. The cell leg's own action has no cell=1,
  // so this happens at most once per call.
  const tryCell = String(req.query.cell ?? "") === "1";
  const unanswered = dialWasNotAnswered(req.body?.DialCallStatus);
  const v = await newVR();
  if (!unanswered) { closeRecord(req); v.hangup(); return send(res, v); }
  const { menu } = await loadMenu(pool as any);
  const ref = String(req.query.target || "");
  const found = targetForRef(menu, ref);
  const ctx = ctxFrom(req, ref, found?.label ?? "");
  const callerId = callerIdFor(req);
  if (found?.target.type === "group") {
    if (tryCell && !callerHungUp(req.body) && found.target.userIds[0]) {
      const lead = await resolveTarget(found.target.userIds[0]);
      if (lead.standaloneWatch && lead.cell) {
        const { rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER - same call record (rx_<CallSid>)
        dialCell(v, lead.cell, `${BASE}/unavailable?target=${encodeURIComponent(ref)}${ctxQuery(ctx)}`, callerId, callerFrom(req), rec, lead.userId);
        return send(res, v);
      }
    }
    await noAnswer(v, req, menu, ctx, groupSorry("noanswer"), null);
    return send(res, v);
  }
  if (found?.target.type === "user") {
    const tt = await resolveTarget(found.target.userId);
    if (tryCell && !callerHungUp(req.body) && tt.standaloneWatch && tt.cell) {
      const { rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER
      dialCell(v, tt.cell, `${BASE}/unavailable?target=${encodeURIComponent(ref)}${ctxQuery(ctx)}`, callerId, callerFrom(req), rec, tt.userId);
      return send(res, v);
    }
    await noAnswer(v, req, menu, ctx, `Sorry, ${found.target.name} didn't pick up.`, tt.userId);
    return send(res, v);
  }
  // The menu changed while this call was ringing: the shared voicemail.
  missedCall(req, ctx.forUserId);
  offerMessageOrVoicemail(v, groupSorry("noanswer"), ctx.forUserId);
  return send(res, v);
}));

// One-at-a-time group: ring the next listed person after `after`, then the no-answer fallback.
router.post("/group-next", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (!dialWasNotAnswered(req.body?.DialCallStatus)) { closeRecord(req); v.hangup(); return send(res, v); }
  const { menu } = await loadMenu(pool as any);
  const ref = String(req.query.target ?? "");
  const found = targetForRef(menu, ref);
  const ctx = ctxFrom(req, ref, found?.label ?? "");
  if (!found || found.target.type !== "group" || callerHungUp(req.body)) { await noAnswer(v, req, menu, ctx, groupSorry("noanswer"), null); return send(res, v); }
  const after = String(req.query.after ?? "");
  const idx = found.target.userIds.indexOf(after);
  const next = idx < 0 ? undefined : (await readyInOrder(found.target.userIds.slice(idx + 1)))[0];
  if (!next) { await noAnswer(v, req, menu, ctx, groupSorry("noanswer"), null); return send(res, v); }
  const { card, rec } = await cardAndRecord(req);
  const action = `${BASE}/group-next?target=${encodeURIComponent(ref)}&after=${encodeURIComponent(next.ref)}${ctxQuery(ctx)}`;
  const dial = v.dial({ answerOnBridge: true, timeout: menu.noAnswer?.ringSeconds ?? DEFAULT_RING_SECONDS, action, method: "POST", callerId: callerIdFor(req), ...recordingDialAttrs(rec) });
  dialClient(dial, next.identity, card, legStatusAttrs(rec ?? legRecordName(req), next.identity));
  return send(res, v);
}));

/** The AI receptionist's pick among the menu's options (keywords first, then OpenAI when configured). */
export async function aiPick(menu: PhoneMenu, said: string, opts: { timeoutMs?: number } = {}): Promise<MenuOption | null> {
  const candidates = allOptions(menu).filter((o) => o.target.type !== "ai" && o.target.type !== "submenu");
  if (!said.trim() || !candidates.length) return null;
  const byWords = chooseOption(candidates, "", said);
  if (byWords) return byWords;
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const client = sharedOpenAI(process.env.OPENAI_API_KEY);
    const list = candidates.map((o, i) => `${i + 1}: ${o.label}${o.keywords.length ? ` (${o.keywords.join(", ")})` : ""}`).join("\n");
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 3500));
    const call = client.chat.completions.create({
      model: process.env.RECEPTION_AI_MODEL || "gpt-4o-mini",
      messages: [
        { role: "system", content: "You route phone calls for the Boreal Group of Companies. Reply with only the number of the best option, or 0 if none fits." },
        { role: "user", content: `Options:\n${list}\n\nThe caller said: "${said.slice(0, 400)}"` },
      ],
    }).then((r: any) => String(r.choices?.[0]?.message?.content ?? "").trim());
    const answer = await Promise.race([call, timeout]);
    const n = Number(/\d+/.exec(String(answer ?? ""))?.[0] ?? 0);
    return n >= 1 && n <= candidates.length ? candidates[n - 1]! : null;
  } catch (err) {
    console.warn("[reception] AI receptionist routing failed; taking a message", { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

router.post("/ai", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const { menu } = await loadMenu(pool as any);
  const ctx = ctxFrom(req, String(req.query.ref ?? ""), "");
  const said = speech(req);
  const option = await aiPick(menu, said);
  console.log(JSON.stringify({ event: "phone_menu_ai", callSid: req.body?.CallSid ?? null, speech: said || null, option: option?.id ?? null }));
  const v = await newVR();
  if (option) {
    await routeTarget(v, req, menu, option.target, { ref: option.id, label: option.label, fallback: ctx.fallback, forUserId: ctx.forUserId });
    return send(res, v);
  }
  missedCall(req, ctx.forUserId);
  offerMessageOrVoicemail(v, PHRASES.opener_unclear!, ctx.forUserId);
  return send(res, v);
}));

// BF_SERVER_v820_WATCH_CALLS - call screening on the staff cell leg (Twilio <Number url>). Runs on the cell once it
// answers, before the caller is bridged: "Boreal call from {name}. Press 1 to accept." 1 connects; anything else,
// or silence (the cell's voicemail), hangs up this leg so the parent <Dial> reports no-answer and the caller goes on
// to Boreal voicemail. The caller number comes from the server-built URL (covered by the Twilio signature).
router.post("/screen", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const from = String(req.query.from ?? "").trim() || callerFrom(req);
  const label = await callerLabel(pool, from);
  const g = v.gather({ input: "dtmf", numDigits: 1, timeout: SCREEN_GATHER_TIMEOUT_SECONDS, action: `${BASE}/screen-result`, method: "POST" });
  g.say({ voice: VOICE }, `Boreal call from ${label}. Press 1 to accept.`);
  v.hangup();
  return send(res, v);
}));

router.post("/screen-result", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (digit(req) === "1") {
    // Ending the screening TwiML without a hangup bridges this leg to the caller.
    v.say({ voice: VOICE }, "Connecting.");
    return send(res, v);
  }
  v.hangup();
  return send(res, v);
}));

router.post("/fallback", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  const wantsVoicemail = d === "2" || /voicemail|voice mail|\bvm\b|message later/.test(s);
  if (wantsVoicemail) emit(v, "vm_prompt", PHRASES.vm_prompt);
  else emit(v, "msg_prompt", PHRASES.msg_prompt);
  v.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
  return send(res, v);
}));

// BF_SERVER_DIRECT_LINES_v688 - nobody answered a direct line: that person's own voicemail.
router.post("/direct-unavailable", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  if (!dialWasNotAnswered(req.body?.DialCallStatus)) { closeRecord(req); return send(res, v); } // BF_SERVER_v820_WATCH_CALLS
  const userId = String(req.query.user ?? "").trim() || null;
  // BF_SERVER_v820_WATCH_CALLS - the app rang for 15 s; now the owner's opted-in cell, screened (once).
  if (userId && String(req.query.cell ?? "") === "1" && !callerHungUp(req.body)) {
    const cell = await verifiedWatchCell(pool, userId);
    if (cell) {
      const from = callerFrom(req);
      const { rec } = await cardAndRecord(req); // BF_SERVER_v821_DIALER
      dialCell(v, cell, `${BASE}/direct-unavailable?user=${encodeURIComponent(userId)}`, from || undefined, from, rec, userId);
      return send(res, v);
    }
  }
  missedCall(req, userId);
  let name = "The person you called";
  if (userId) {
    try {
      const r = await pool.query<{ first_name: string | null }>(`SELECT first_name FROM users WHERE id::text = $1 LIMIT 1`, [userId]);
      if (r.rows[0]?.first_name) name = String(r.rows[0].first_name);
    } catch (err: any) {
      console.warn("[reception] direct line name lookup failed", { message: err?.message });
    }
  }
  offerMessageOrVoicemail(v, `Sorry, ${name} isn't available right now.`, userId);
  return send(res, v);
}));

// BF_SERVER_v821_DIALER - the away prompt's answer. 1 -> ring the person as normal (app first, then the v820 cell
// fallback). Any other key -> their voicemail. (No key at all never reaches here: the <Gather> falls through to the
// voicemail <Record> that follows it.) ring = direct | sales | underwriting; the user id comes from our own URL.
router.post("/away-choice", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const v = await newVR();
  const userId = String(req.query.user ?? "").trim();
  const ring = String(req.query.ring ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(userId)) { staffVoicemail(v, null); return send(res, v); }
  if (digit(req) !== "1") { staffVoicemail(v, userId); return send(res, v); }
  console.log(JSON.stringify({ event: "call_hours_urgent_passthrough", callSid: req.body?.CallSid ?? null, staffUserId: userId, ring }));
  if (ring === "direct") {
    let owner: { userId: string; identity: string } | null = null;
    try {
      const r = await pool.query<{ twilio_identity: string | null }>(
        `SELECT sp.twilio_identity FROM users u LEFT JOIN staff_presence sp ON sp.user_id = u.id WHERE u.id::text = $1 LIMIT 1`, [userId]);
      if (r.rows.length) owner = { userId, identity: String(r.rows[0]?.twilio_identity || userId) };
    } catch (err: any) {
      console.warn("[reception] away passthrough owner lookup failed", { message: err?.message });
    }
    if (!owner) { staffVoicemail(v, userId); return send(res, v); }
    await ringDirectLine(v, pool, { owner, from: callerFrom(req), callSid: String(req.body?.CallSid ?? "") });
    return send(res, v);
  }
  // BF_SERVER_v869_PHONE_MENU - ring = the menu option that rang them (the default menu: sales / underwriting).
  const { menu } = await loadMenu(pool as any);
  const opt = findOption(menu, ring);
  if (opt?.target.type === "user") {
    await ringNamedTarget(v, req, menu, opt.target, await resolveTarget(opt.target.userId), { ref: opt.id, label: opt.label, fallback: false, forUserId: null });
    return send(res, v);
  }
  staffVoicemail(v, userId);
  return send(res, v);
}));

// BF_SERVER_v821_DIALER - a staff leg of a recorded <Dial> was answered / ended (Twilio <Client>/<Number>
// statusCallback). The answering staff member joins the call record under the leg's own CallSid - the one the
// iPhone app holds - so GET /api/calls/:callSid/summary finds the call and lets them read it.
router.post("/leg-status", twilioWebhookValidation, safeHandler(async (req: Request, res: Response) => {
  const friendlyName = String(req.query.conf ?? "").trim();
  const identity = String(req.query.identity ?? "").trim();
  const callSid = String(req.body?.CallSid ?? "").trim();
  if (friendlyName && identity && callSid) {
    await recordLegStatus(pool, { friendlyName, identity, callSid, status: String(req.body?.CallStatus ?? ""), parentCallSid: String(req.body?.ParentCallSid ?? "").trim() || null }); // BF_SERVER_v829_DIALER_RELIABILITY
  }
  return res.status(204).end();
}));

// BF_SERVER_v821_DIALER - <Number url>: the called party hears the recording notice before being connected.
router.post("/recording-notice", twilioWebhookValidation, safeHandler(async (_req: Request, res: Response) => {
  const v = await newVR();
  v.say({ voice: VOICE }, RECORDING_NOTICE);
  return send(res, v);
}));

if (novaOn()) { void warmReceptionVoice(); }

export default router;
