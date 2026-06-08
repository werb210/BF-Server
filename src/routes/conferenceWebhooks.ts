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
import { bumpBiOutreachToContacted } from "../services/biOutreach.js"; // BF_SERVER_BLOCK_v744
import recordingWebhooksRoutes from "./recordingWebhooks.js";
import transcriptionWebhooksRoutes from "./transcriptionWebhooks.js";

import VoiceResponse from "twilio/lib/twiml/VoiceResponse.js";

const router = Router();

router.post("/conference/join", twilioWebhookValidation, async (req: any, res) => {
  res.setHeader("Content-Type", "text/xml");
  const conf = String(req.query.conf ?? req.body?.conf ?? "").trim();
  const pid  = String(req.query.pid ?? req.body?.pid ?? "").trim();
  const callSid = String(req.body?.CallSid ?? "").trim();
  const from = String(req.body?.From ?? "").trim();
  const base = getPublicBaseUrl();
  const vr = new VoiceResponse();

  if (!conf) {
    vr.say({ voice: "Polly.Joanna" }, "Conference identifier missing. Goodbye.");
    vr.hangup();
    return res.send(vr.toString());
  }

  // BF_SERVER_BLOCK_v654_DIALER_FIX_v1 — multiple compounding issues
  // produced the "chirp every second" symptom and the dialer never
  // working end-to-end. See the block intent for the full list. Summary:
  //   1. beep defaulted to TRUE — periodic chirp on any participant flap.
  //   2. participantLabel is NOT a valid <Conference> TwiML attribute.
  //   3. record="record-from-start" was unconditional — fails the entire
  //      <Conference> verb if the account lacks recording capability.
  //   4. waitUrl="" is documented behavior-undefined.
  //   5. endConferenceOnExit=false stranded the other party on hangup.
  const enableRecording = process.env.ENABLE_CALL_RECORDING === "true";
  // BF_SERVER_BLOCK_v764_RECORDING_CONSENT — Canada is two-party consent.
  // Announce recording to each party as they join a recorded conference,
  // before they enter. Only when recording is actually on.
  if (enableRecording) {
    vr.say({ voice: "Polly.Joanna" }, "This call may be recorded for quality and training purposes.");
  }
  const dial = vr.dial({ answerOnBridge: true });
  const confAttrs: Record<string, unknown> = {
    statusCallback: `${base}/api/webhooks/twilio/conference/status?conf=${encodeURIComponent(conf)}`,
    statusCallbackEvent: "start end join leave mute hold",
    statusCallbackMethod: "POST",
    startConferenceOnEnter: true,
    // 2-party PSTN call: either party hangup ends the conference.
    endConferenceOnExit: true,
    // No periodic chirp on participant flap.
    beep: false,
    trim: "trim-silence",
  };
  if (enableRecording) {
    confAttrs.record = "record-from-start";
    confAttrs.recordingChannels = "dual";
    confAttrs.recordingStatusCallback = `${base}/api/webhooks/twilio/recording/status?conf=${encodeURIComponent(conf)}`;
    confAttrs.recordingStatusCallbackEvent = "in-progress completed absent";
    confAttrs.recordingStatusCallbackMethod = "POST";
  }
  dial.conference(confAttrs as any, conf);

  const twiml = vr.toString();
  console.log(JSON.stringify({
    event: "conference_join_twiml",
    conf,
    pid: pid || null,
    callSid: callSid || null,
    from: from || null,
    recordingEnabled: enableRecording,
    twiml_bytes: twiml.length,
  }));
  return res.send(twiml);
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
    case "conference-end": {
      // BF_SERVER_BLOCK_v744 — guarded so duplicate Twilio conference-end
      // callbacks only log the call once. On the first end of an OUTBOUND
      // conference tied to a contact, write a call.ended event (lands on the
      // CRM timeline) and advance a BI outreach lead New->Contacted.
      const endRow = await pool.query(
        `UPDATE conferences SET status = 'ended', ended_at = now(), updated_at = now()
           WHERE id = $1 AND COALESCE(status, '') <> 'ended'
         RETURNING contact_id, direction, silo, created_by_user_id,
                   GREATEST(0, EXTRACT(EPOCH FROM (now() - created_at)))::int AS duration_seconds`,
        [conf.id],
      );
      const er: any = endRow.rows[0];
      if (er && er.contact_id && er.direction === "outbound") {
        try {
          await pool.query(
            `INSERT INTO call_events
               (user_id, contact_id, silo, event_type, direction, twilio_call_sid, duration_seconds, payload)
             VALUES ($1, $2::uuid, $3, 'call.ended', 'outbound', $4, $5, $6::jsonb)`,
            [er.created_by_user_id ?? null, er.contact_id, er.silo ?? "BF",
             confSid || conf.twilio_conference_sid || null, er.duration_seconds ?? 0,
             JSON.stringify({ conference_id: conf.id, source: "conference-end" })],
          );
        } catch { /* timeline logging is best-effort; never break the webhook */ }
        void bumpBiOutreachToContacted(String(er.contact_id));
      }
      break;
    }
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
    case "participant-leave": {
      let leftKind: string | null = null;
      if (label) {
        const r = await pool.query<{ kind: string | null }>(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE id = $1 RETURNING kind`, [label]);
        leftKind = r.rows[0]?.kind ?? null;
      } else if (callSid) {
        const r = await pool.query<{ kind: string | null }>(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE twilio_call_sid = $1 RETURNING kind`, [callSid]);
        leftKind = r.rows[0]?.kind ?? null;
      }
      // BF_SERVER_BLOCK_v699_CALLER_HANGUP_CANCELS_RING_v1
      // If the caller (client mini-portal / inbound PSTN) hangs up before any
      // staff answers, the ring-all staff legs were left ringing forever — the
      // sibling-cancel only ran on participant-join. Cancel the outstanding staff
      // legs and end the conference so the portal stops ringing.
      if ((conf.direction === "client_miniportal" || conf.direction === "inbound") && leftKind && leftKind !== "staff") {
        const joinedStaff = await pool.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM conference_participants WHERE conference_id = $1 AND kind = 'staff' AND status = 'joined'`,
          [conf.id],
        );
        if ((joinedStaff.rows[0]?.c ?? 0) === 0) {
          const pending = await pool.query<{ id: string; identity: string }>(
            `SELECT id, identity FROM conference_participants
              WHERE conference_id = $1 AND kind = 'staff' AND status IN ('invited','ringing')`,
            [conf.id],
          );
          const { cancelPendingParticipantCall, broadcastIncomingAnswered } = await import("../voice/conferenceService.js");
          for (const lo of pending.rows) {
            try { await cancelPendingParticipantCall(lo.id); } catch { /* leg may already be gone */ }
          }
          const ids: string[] = pending.rows.map((r) => String(r.identity));
          if (ids.length) await broadcastIncomingAnswered(ids, conf.friendly_name, "");
          await pool.query(`UPDATE conferences SET status = 'ended', ended_at = now(), updated_at = now() WHERE id = $1`, [conf.id]);
        }
      }
      break;
    }
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

// v502b -- siblings live on the same /webhooks/twilio mount
router.use("/", recordingWebhooksRoutes);
router.use("/", transcriptionWebhooksRoutes);

export default router;
