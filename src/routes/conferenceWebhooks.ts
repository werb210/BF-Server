// BF_SERVER_BLOCK_v501_OUTBOUND_CORE_v1
// Twilio conference-join TwiML + status callbacks.

import express, { Router } from "express";
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

// BF_SERVER_BLOCK_v2_LIVE_TRANSCRIPTION - twilio-node 4.x has no <Transcription>
// verb, so inject it as raw TwiML. Gated by ENABLE_LIVE_TRANSCRIPTION (default
// off, reversible without redeploy) and only on the staff leg (!isCallerLeg)
// with both_tracks => staff inbound + caller (conference mix) outbound, so the
// conversation is transcribed once. Events POST to the existing
// /transcription/event handler, which emits transcript.live over SSE.
export function injectLiveTranscription(twiml: string, base: string, conf: string, isCallerLeg: boolean): string {
  if (process.env.ENABLE_LIVE_TRANSCRIPTION !== "true" || isCallerLeg) return twiml;
  const txUrl = `${base}/api/webhooks/twilio/transcription/event?conf=${encodeURIComponent(conf)}`;
  const startTx = `<Start><Transcription statusCallbackUrl="${txUrl}" track="both_tracks" partialResults="true"/></Start>`;
  return twiml.replace("<Response>", `<Response>${startTx}`);
}

const router = Router();

// BF_SERVER_BLOCK_vA_CONF_URLENCODED_v1 — Twilio posts urlencoded; app.ts only
// applies express.json globally. Without this, req.body={} on every conference
// webhook -> signature computed over empty body -> 403 -> conference never forms.
// Mounted before the route defs so recording/transcription subrouters inherit it.
router.use(express.urlencoded({ extended: false }));

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
  // BF_SERVER_BLOCK_v771_RECORDING_DEFAULT_ON: recording + the Canada
  // two-party consent announcement are core, not opt-in. On by default; the
  // only kill switch is an explicit ENABLE_CALL_RECORDING="false".
  const enableRecording = process.env.ENABLE_CALL_RECORDING !== "false";
  // BF_SERVER_BLOCK_v764_RECORDING_CONSENT — Canada is two-party consent.
  // Announce recording to each party as they join a recorded conference,
  // before they enter. Only when recording is actually on.
  if (enableRecording) {
    vr.say({ voice: "Polly.Joanna" }, "This call may be recorded for quality and training purposes.");
  }
  // BF_SERVER_BLOCK_v843_NO_ANSWER_VOICEMAIL — look up this leg's kind so the
  // caller (pstn / client_miniportal) waits with a bounded hold that falls to
  // voicemail when nobody answers, while staff legs start the conference on join.
  let legKind: string | null = null;
  if (pid) {
    const kr = await pool.query<{ kind: string | null }>(
      `SELECT kind FROM conference_participants WHERE id = $1 LIMIT 1`, [pid],
    ).catch(() => ({ rows: [] as any[] }));
    legKind = kr.rows[0]?.kind ?? null;
  }
  const isCallerLeg = legKind === "pstn" || legKind === "client_miniportal";

  const dial = vr.dial({ answerOnBridge: true });
  const confAttrs: Record<string, unknown> = {
    statusCallback: `${base}/api/webhooks/twilio/conference/status?conf=${encodeURIComponent(conf)}`,
    statusCallbackEvent: "start end join leave mute hold",
    statusCallbackMethod: "POST",
    // Caller waits (doesn't start conf) so its waitUrl can escape to voicemail on
    // no-answer; staff joining starts the conference and ends the caller's wait.
    startConferenceOnEnter: isCallerLeg ? false : true,
    // 2-party PSTN call: either party hangup ends the conference.
    endConferenceOnExit: true,
    // No periodic chirp on participant flap.
    beep: false,
    trim: "trim-silence",
  };
  if (isCallerLeg) {
    confAttrs.waitUrl = `${base}/api/webhooks/twilio/conference/wait?conf=${encodeURIComponent(conf)}&pid=${encodeURIComponent(pid)}&n=0`;
    confAttrs.waitMethod = "POST";
  }
  if (enableRecording) {
    confAttrs.record = "record-from-start";
    confAttrs.recordingChannels = "dual";
    confAttrs.recordingStatusCallback = `${base}/api/webhooks/twilio/recording/status?conf=${encodeURIComponent(conf)}`;
    confAttrs.recordingStatusCallbackEvent = "in-progress completed absent";
    confAttrs.recordingStatusCallbackMethod = "POST";
  }
  dial.conference(confAttrs as any, conf);

  const twiml = injectLiveTranscription(vr.toString(), base, conf, isCallerLeg);
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

// BF_SERVER_BLOCK_v843_NO_ANSWER_VOICEMAIL — caller hold loop with voicemail escape.
router.post("/conference/wait", twilioWebhookValidation, async (req: any, res) => {
  res.setHeader("Content-Type", "text/xml");
  const base = getPublicBaseUrl();
  const conf = String(req.query.conf ?? req.body?.conf ?? "").trim();
  const pid  = String(req.query.pid ?? req.body?.pid ?? "").trim();
  const n = Number.parseInt(String(req.query.n ?? "0"), 10) || 0;
  const vr = new VoiceResponse();

  if (conf) {
    const joined = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM conference_participants cp
         JOIN conferences c ON c.id = cp.conference_id
        WHERE c.friendly_name = $1 AND cp.kind = 'staff' AND cp.status = 'joined'`,
      [conf],
    ).catch(() => ({ rows: [{ c: 0 }] }));
    if ((joined.rows[0]?.c ?? 0) > 0) {
      vr.play({ loop: 1 }, "http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-Borghestral.mp3");
      return res.send(vr.toString());
    }
  }

  if (n >= 3) {
    vr.say({ voice: "Polly.Joanna" }, "Sorry, no one is available to take your call. Please leave a message after the tone and we will call you back.");
    vr.record({
      action: `${base}/api/webhooks/twilio/voicemail`,
      method: "POST",
      maxLength: 120,
      transcribe: false,
      playBeep: true,
    });
    return res.send(vr.toString());
  }

  // BF_SERVER_NO_ANSWER_15S — bounded ~5s hold per poll so an unanswered caller
  // reaches voicemail in ~15s (3 polls) instead of being parked behind a ~60s
  // music track per poll (~4 min to voicemail). A staff answer starts the
  // conference and bridges the caller out of this loop automatically.
  if (n === 0) {
    vr.say({ voice: "Polly.Joanna" }, "Please hold while we connect your call.");
  }
  vr.pause({ length: 5 });
  vr.redirect({ method: "POST" }, `${base}/api/webhooks/twilio/conference/wait?conf=${encodeURIComponent(conf)}&pid=${encodeURIComponent(pid)}&n=${n + 1}`);
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
