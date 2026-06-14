// BF_SERVER_RECEPTION_v1 — Maya phone receptionist (speech + keypad fallback).
// Flow: recording notice + BF/BRM split -> intent -> ring Todd (sales) or
// Andrew (underwriting / named-lender) on their browser softphone when they are
// genuinely available (presence reflects hours + on-call + in-meeting + manual),
// else offer "take a message" or "leave a voicemail". Every dead-end records to
// the existing /voicemail handler, so a caller is never dropped.
import express, { Router, type Request, type Response } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { pool } from "../db.js";

const router = Router();

// Twilio webhooks post application/x-www-form-urlencoded payloads, and the
// signature validator needs the parsed params to validate the request.
router.use(express.urlencoded({ extended: false }));

const VOICE = "Polly.Joanna";
const BASE = "/api/webhooks/twilio/reception";

function speech(req: Request): string { return String((req.body?.SpeechResult ?? "") as string).toLowerCase(); }
function digit(req: Request): string { return String((req.body?.Digits ?? "") as string).trim(); }
async function newVR(): Promise<any> {
  const { default: VoiceResponse } = await import("twilio/lib/twiml/VoiceResponse.js");
  return new VoiceResponse();
}
function send(res: Response, v: any): Response { res.setHeader("Content-Type", "text/xml"); return res.send(v.toString()); }

type Target = "sales" | "underwriting";
function displayFor(t: Target): string { return t === "sales" ? "Todd" : "Andrew"; }

async function resolveTarget(t: Target): Promise<{ identity: string | null; available: boolean; onCall: boolean }> {
  const nameLike = t === "sales" ? "%todd%" : "%andrew%";
  try {
    const { rows } = await pool.query<{ status: string; twilio_identity: string | null; on_call: boolean }>(
      `SELECT sp.status, sp.twilio_identity, coalesce(sp.on_call, false) AS on_call
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE u.name ILIKE $1 ORDER BY sp.last_heartbeat DESC NULLS LAST LIMIT 1`,
      [nameLike],
    );
    const r = rows[0];
    if (!r) return { identity: null, available: false, onCall: false };
    return { identity: r.twilio_identity, available: r.status === "available" && !!r.twilio_identity, onCall: !!r.on_call };
  } catch { return { identity: null, available: false, onCall: false }; }
}

function offerMessageOrVoicemail(v: any, opener: string): void {
  const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action: `${BASE}/fallback`, method: "POST" });
  g.say({ voice: VOICE }, `${opener} Would you like me to take a message and pass it on, or would you like to leave a voicemail? Say message, or press 1. Say voicemail, or press 2.`);
  v.say({ voice: VOICE }, "Please leave your name, number, and a brief message after the tone.");
  v.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
}

router.post("/greeting", twilioWebhookValidation, async (_req: Request, res: Response) => {
  const v = await newVR();
  const g = v.gather({ input: "speech dtmf", numDigits: 1, speechTimeout: "auto", timeout: 6, action: `${BASE}/company`, method: "POST" });
  g.say({ voice: VOICE }, "This call is recorded for quality. Welcome to the Boreal Group of Companies. Are you looking to reach Boreal Financial, or Boreal Risk Management? You can say it, or press 1 for Financial, 2 for Risk Management.");
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
  g.say({ voice: VOICE }, "Thanks. What can I help you with, or who would you like to reach? You can say sales, underwriting, or a person's name. Or press 1 for sales, 2 for underwriting.");
  v.redirect({ method: "POST" }, `${BASE}/intent?company=${company}`);
  return send(res, v);
});

router.post("/intent", twilioWebhookValidation, async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  if (/caden/.test(s)) { offerMessageOrVoicemail(v, "Let me take a message for the team."); return send(res, v); }
  if (/address|location|where are you|directions/.test(s)) {
    v.say({ voice: VOICE }, "You can reach us through the contact form on our website.");
    offerMessageOrVoicemail(v, "I can also take your details and notify the team."); return send(res, v);
  }
  const wantsAndrew = d === "2" || /andrew|underwrit|document|condition|approval|declin|status|lender/.test(s);
  const wantsTodd = d === "1" || /todd|sales|apply|\bnew\b|financ|funding|loan|quote|get started/.test(s);
  const target: Target | null = wantsAndrew ? "underwriting" : wantsTodd ? "sales" : null;
  if (!target) { offerMessageOrVoicemail(v, "Let me take a message and make sure the right person follows up."); return send(res, v); }
  const t = await resolveTarget(target);
  const name = displayFor(target);
  if (t.available && t.identity) {
    v.say({ voice: VOICE }, `One moment, connecting you to ${name}.`);
    const dial = v.dial({ answerOnBridge: true, timeout: 20, action: `${BASE}/unavailable?target=${target}`, method: "POST" });
    dial.client(t.identity);
    return send(res, v);
  }
  const reason = t.onCall ? "is on another call" : "isn't available right now";
  offerMessageOrVoicemail(v, `Sorry, ${name} ${reason}.`);
  return send(res, v);
});

router.post("/unavailable", twilioWebhookValidation, async (req: Request, res: Response) => {
  const target = (String(req.query.target || "") === "underwriting" ? "underwriting" : "sales") as Target;
  const dialStatus = String(req.body?.DialCallStatus ?? "");
  const v = await newVR();
  if (dialStatus === "completed") { v.hangup(); return send(res, v); }
  offerMessageOrVoicemail(v, `Sorry, ${displayFor(target)} didn't pick up.`);
  return send(res, v);
});

router.post("/fallback", twilioWebhookValidation, async (req: Request, res: Response) => {
  const s = speech(req); const d = digit(req);
  const v = await newVR();
  const wantsVoicemail = d === "2" || /voicemail|voice mail|\bvm\b|message later/.test(s);
  if (wantsVoicemail) v.say({ voice: VOICE }, "Please leave your message after the tone.");
  else v.say({ voice: VOICE }, "Sure — please tell me your name, number, and what it's about after the tone, and I'll pass it to the team.");
  v.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail" });
  return send(res, v);
});

export default router;
