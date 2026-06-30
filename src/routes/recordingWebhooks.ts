// BF_SERVER_BLOCK_v502_RECORDING_TRANSCRIPTION_v1
import { Router } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { pool } from "../db.js";
import { persistTwilioMediaToBlob } from "../services/mmsMedia.js"; // BF_SERVER_RECORDING_BLOB_PERSIST_v1
import { getConferenceByFriendly, notifyConferenceState } from "../voice/conferenceService.js";
import { getTwilio } from "../voice/twilioClient.js";

const router = Router();

router.post("/recording/status", twilioWebhookValidation, async (req: any, res) => {
  const confFriendly = String(req.query.conf ?? "").trim();
  const recSid = String(req.body?.RecordingSid ?? "").trim();
  const status = String(req.body?.RecordingStatus ?? "").trim();
  const url = String(req.body?.RecordingUrl ?? "").trim();
  const dur = Number(req.body?.RecordingDuration ?? 0);
  const chan = Number(req.body?.RecordingChannels ?? 2);

  if (!recSid || !confFriendly) return res.status(200).send("");
  const conf = await getConferenceByFriendly(confFriendly);
  if (!conf) return res.status(200).send("");

  await pool.query(
    `INSERT INTO call_recordings (conference_id, twilio_recording_sid, url, duration_sec, channels, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (twilio_recording_sid) DO UPDATE
       SET url = EXCLUDED.url, duration_sec = EXCLUDED.duration_sec,
           status = EXCLUDED.status, updated_at = now()`,
    [conf.id, recSid, url || null, dur || null, chan || 2, status || "in-progress"],
  );
  if (status === "completed" && url) {
    await pool.query(
      `UPDATE conferences SET recording_sid = $2, recording_url = $3, updated_at = now() WHERE id = $1`,
      [conf.id, recSid, url],
    );
    // BF_SERVER_RECORDING_BLOB_PERSIST_v1 - copy the recording to public blob so
    // the contact-card <audio> plays without Twilio creds and survives purge.
    void (async () => {
      const persisted = await persistTwilioMediaToBlob(url);
      if (persisted) {
        await pool
          .query("UPDATE call_recordings SET url = $2 WHERE twilio_recording_sid = $1", [recSid, persisted.url])
          .catch(() => {});
        await pool
          .query("UPDATE conferences SET recording_url = $2 WHERE id = $1", [conf.id, persisted.url])
          .catch(() => {});
      }
    })();
    // Fire Voice Intelligence transcript on the completed recording (best-effort).
    void triggerVoiceIntelligence(conf.id, recSid).catch((e) =>
      console.warn("vi_trigger_failed", { conf: conf.id, recSid, message: e?.message }),
    );
  }
  await notifyConferenceState(conf.id, "recording.update", { recSid, status, url, dur });
  return res.status(200).send("");
});

async function triggerVoiceIntelligence(conferenceId: string, recordingSid: string) {
  const serviceSid = process.env.VOICE_INTELLIGENCE_SERVICE_SID;
  if (!serviceSid) return;
  const tw = getTwilio();
  const transcript = await tw.intelligence.v2.transcripts.create({
    serviceSid,
    channel: { media_properties: { source_sid: recordingSid } },
  });
  await pool.query(
    `INSERT INTO call_transcripts (conference_id, voice_intelligence_sid, status)
     VALUES ($1, $2, 'in-progress')
     ON CONFLICT (transcription_sid) DO NOTHING`,
    [conferenceId, transcript.sid],
  );
  const start = Date.now();
  const deadline = start + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    try {
      const t = await tw.intelligence.v2.transcripts(transcript.sid).fetch();
      if (t.status === "completed") {
        const sentences = await tw.intelligence.v2.transcripts(transcript.sid).sentences.list({ limit: 1000 });
        const fullText = sentences.map((s: any) => s.transcript ?? "").join(" ").trim();
        await pool.query(
          `UPDATE call_transcripts SET status = 'completed', full_text = $2, segments_json = $3, updated_at = now() WHERE voice_intelligence_sid = $1`,
          [
            transcript.sid,
            fullText,
            JSON.stringify(
              sentences.map((s: any) => ({
                speaker: s.media_channel,
                text: s.transcript,
                start: s.startTime,
                end: s.endTime,
              })),
            ),
          ],
        );
        const { notifyConferenceState } = await import("../voice/conferenceService.js");
        await notifyConferenceState(conferenceId, "transcript.completed", { viSid: transcript.sid });
        return;
      }
      if (t.status === "failed") {
        await pool.query(
          `UPDATE call_transcripts SET status = 'failed', updated_at = now() WHERE voice_intelligence_sid = $1`,
          [transcript.sid],
        );
        return;
      }
    } catch (e: any) {
      console.warn("vi_poll_error", { message: e?.message });
      break;
    }
  }
}

export default router;
