// BF_SERVER_BLOCK_v501_OUTBOUND_CORE_v1
// Twilio conference-join TwiML + status callbacks.

import { Router } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { pool } from "../db.js";
import {
  getConferenceByFriendly,
  getParticipantBySid,
  notifyConferenceState,
} from "../voice/conferenceService.js";
import { getPublicBaseUrl } from "../voice/twilioClient.js";

import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";

const router = Router();

router.post("/conference/join", twilioWebhookValidation, async (req: any, res) => {
  res.setHeader("Content-Type", "text/xml");
  const conf = String(req.query.conf ?? req.body?.conf ?? "").trim();
  const pid  = String(req.query.pid ?? req.body?.pid ?? "").trim();
  const base = getPublicBaseUrl();
  const vr = new VoiceResponse();

  if (!conf) {
    vr.say({ voice: "Polly.Joanna" }, "Conference identifier missing. Goodbye.");
    vr.hangup();
    return res.send(vr.toString());
  }

  // Real-time per-leg transcription (this leg's audio only).
  const xcr = (vr as any).start();
  xcr.transcription({
    name: `xcr_${conf}_${pid || "x"}`,
    statusCallbackUrl: `${base}/api/webhooks/twilio/transcription/event?conf=${encodeURIComponent(conf)}&pid=${encodeURIComponent(pid)}`,
    track: "inbound_track",
    languageCode: "en-US",
    partialResults: true,
  });

  const dial = vr.dial({ answerOnBridge: true });
  dial.conference({
    statusCallback: `${base}/api/webhooks/twilio/conference/status?conf=${encodeURIComponent(conf)}`,
    statusCallbackEvent: "start end join leave mute hold",
    statusCallbackMethod: "POST",
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    waitUrl: "",
    participantLabel: pid || undefined,
    // Dual-channel recording on the first joiner; subsequent participants
    // ignore "record" attribute. Twilio mixes the rest into the same file.
    record: "record-from-start",
    recordingChannels: "dual",
    recordingStatusCallback: `${base}/api/webhooks/twilio/recording/status?conf=${encodeURIComponent(conf)}`,
    recordingStatusCallbackEvent: "in-progress completed absent",
    recordingStatusCallbackMethod: "POST",
    trim: "trim-silence",
  } as any, conf);

  return res.send(vr.toString());
});

router.post("/conference/status", twilioWebhookValidation, async (req: any, res) => {
  const event = String(req.body?.StatusCallbackEvent ?? "").trim();
  const confFriendly = String(req.query.conf ?? req.body?.FriendlyName ?? "").trim();
  const confSid = String(req.body?.ConferenceSid ?? "").trim();
  const callSid = String(req.body?.CallSid ?? "").trim();
  const label   = String(req.body?.ParticipantLabel ?? "").trim();

  const conf = await getConferenceByFriendly(confFriendly);
  if (!conf) return res.status(200).send("");

  if (confSid && conf.twilio_conference_sid !== confSid) {
    await pool.query(`UPDATE conferences SET twilio_conference_sid = $2, updated_at = now() WHERE id = $1`, [conf.id, confSid]);
  }

  switch (event) {
    case "conference-start":
      await pool.query(`UPDATE conferences SET status = 'active', updated_at = now() WHERE id = $1`, [conf.id]);
      break;
    case "conference-end":
      await pool.query(`UPDATE conferences SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = $1`, [conf.id]);
      break;
    case "participant-join": {
      if (label) {
        await pool.query(`UPDATE conference_participants SET status = 'joined', joined_at = COALESCE(joined_at, now()), twilio_call_sid = COALESCE(twilio_call_sid, $2) WHERE id = $1`, [label, callSid || null]);
      } else if (callSid) {
        await pool.query(`UPDATE conference_participants SET status = 'joined', joined_at = COALESCE(joined_at, now()) WHERE twilio_call_sid = $1`, [callSid]);
      }
      // v503: ring-all winner cancels outstanding staff legs.
      if (conf.direction === "inbound" || conf.direction === "client_miniportal") {
        const joinedStaff = await pool.query(
          `SELECT COUNT(*)::int AS c FROM conference_participants WHERE conference_id = $1 AND kind = 'staff' AND status = 'joined'`,
          [conf.id],
        );
        if ((joinedStaff.rows[0]?.c ?? 0) === 1) {
          const losers = await pool.query(
            `SELECT id, identity FROM conference_participants
              WHERE conference_id = $1 AND kind = 'staff' AND status IN ('invited','ringing')`,
            [conf.id],
          );
          const { cancelPendingParticipantCall, broadcastIncomingAnswered } = await import("../voice/conferenceService.js");
          for (const lo of losers.rows) {
            await cancelPendingParticipantCall(lo.id);
          }
          const loserIdentities: string[] = losers.rows.map((r: any) => String(r.identity));
          if (loserIdentities.length) {
            await broadcastIncomingAnswered(loserIdentities, conf.friendly_name, label || callSid || "");
          }
        }
      }
      break;
    }
    case "participant-leave":
      if (label) await pool.query(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE id = $1`, [label]);
      else if (callSid) await pool.query(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE twilio_call_sid = $1`, [callSid]);
      break;
    case "participant-mute":
      if (label) await pool.query(`UPDATE conference_participants SET muted = $2 WHERE id = $1`, [label, String(req.body?.Muted) === "true"]);
      break;
    case "participant-hold":
      if (label) await pool.query(`UPDATE conference_participants SET on_hold = $2 WHERE id = $1`, [label, String(req.body?.Hold) === "true"]);
      break;
  }

  await notifyConferenceState(conf.id, "conference.update", { event });
  return res.status(200).send("");
});

router.post("/call/status", twilioWebhookValidation, async (req: any, res) => {
  const callSid = String(req.body?.CallSid ?? "").trim();
  const status  = String(req.body?.CallStatus ?? "").trim();
  if (!callSid) return res.status(200).send("");
  const part = await getParticipantBySid(callSid);
  if (!part) return res.status(200).send("");

  let newStatus = part.status;
  if (status === "ringing") newStatus = "ringing";
  else if (status === "in-progress" || status === "answered") newStatus = "joined";
  else if (["completed", "canceled", "failed", "busy", "no-answer"].includes(status)) newStatus = "left";

  await pool.query(`UPDATE conference_participants SET status = $2, left_at = CASE WHEN $2 = 'left' THEN now() ELSE left_at END WHERE id = $1`, [part.id, newStatus]);
  await notifyConferenceState(part.conference_id, "conference.update", { callSid, callStatus: status });
  return res.status(200).send("");
});

export default router;
