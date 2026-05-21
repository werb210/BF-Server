// BF_SERVER_BLOCK_v502_RECORDING_TRANSCRIPTION_v1
import { Router } from "express";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { getConferenceByFriendly, notifyConferenceState } from "../voice/conferenceService.js";

const router = Router();

// Fired by Twilio for each transcription event:
//   transcription-started | transcription-content | transcription-stopped | transcription-error
router.post("/transcription/event", twilioWebhookValidation, async (req: any, res) => {
  const confFriendly = String(req.query.conf ?? "").trim();
  const pid = String(req.query.pid ?? "").trim();
  const event = String(req.body?.TranscriptionEvent ?? "").trim();
  const txSid = String(req.body?.TranscriptionSid ?? "").trim();
  const data = String(req.body?.TranscriptionData ?? "");
  const final = String(req.body?.Final ?? "false") === "true";
  if (!confFriendly) return res.status(200).send("");
  const conf = await getConferenceByFriendly(confFriendly);
  if (!conf) return res.status(200).send("");

  if (event === "transcription-content" && data) {
    let parsed: any = null;
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = { transcript: data };
    }
    const text = String(parsed?.transcript ?? "").trim();
    await notifyConferenceState(conf.id, "transcript.live", {
      pid,
      txSid,
      text,
      final,
      ts: new Date().toISOString(),
    });
  }
  if (event === "transcription-stopped" || event === "transcription-error") {
    await notifyConferenceState(conf.id, "transcript.live.ended", { pid, txSid, event });
  }
  return res.status(200).send("");
});

router.post("/recording/pause", twilioWebhookValidation, async (req: any, res) => {
  void req;
  res.status(200).send("");
});

export default router;
