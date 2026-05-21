// BF_SERVER_BLOCK_v504_MIDCALL_CONTROLS_v1
import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { pool } from "../db.js";
import { getTwilio, getCallerId, getPublicBaseUrl } from "../voice/twilioClient.js";
import {
  getConferenceById, getParticipantById, addParticipantRow,
  dialPstnIntoConference, dialClientIntoConference, notifyConferenceState,
} from "../voice/conferenceService.js";

const router = Router();

function normalizeE164(raw: string): string {
  const s = (raw ?? "").trim();
  if (/^\+\d{8,15}$/.test(s)) return s;
  const digits = s.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

async function userMaySee(userId: string, conferenceId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM conferences c
       LEFT JOIN conference_participants p ON p.conference_id = c.id AND p.identity = $2
      WHERE c.id = $1 AND (c.created_by_user_id = $2 OR p.identity = $2)
      LIMIT 1`,
    [conferenceId, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

router.post("/conferences/:id/participants/:pid/mute", auth, async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const part = await getParticipantById(req.params.pid);
  const conf = await getConferenceById(req.params.id);
  if (!part || !conf?.twilio_conference_sid) return res.status(404).json({ ok: false });
  const muted = !!req.body?.muted;
  await getTwilio().conferences(conf.twilio_conference_sid).participants(part.twilio_call_sid).update({ muted });
  await pool.query(`UPDATE conference_participants SET muted = $2 WHERE id = $1`, [part.id, muted]);
  void notifyConferenceState(conf.id, "conference.update", { pid: part.id, muted });
  return res.json({ ok: true });
});

router.post("/conferences/:id/participants/:pid/hold", auth, async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const part = await getParticipantById(req.params.pid);
  const conf = await getConferenceById(req.params.id);
  if (!part || !conf?.twilio_conference_sid) return res.status(404).json({ ok: false });
  const hold = !!req.body?.hold;
  await getTwilio().conferences(conf.twilio_conference_sid).participants(part.twilio_call_sid).update({ hold });
  await pool.query(`UPDATE conference_participants SET on_hold = $2 WHERE id = $1`, [part.id, hold]);
  void notifyConferenceState(conf.id, "conference.update", { pid: part.id, hold });
  return res.json({ ok: true });
});

router.delete("/conferences/:id/participants/:pid", auth, async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const part = await getParticipantById(req.params.pid);
  const conf = await getConferenceById(req.params.id);
  if (!part || !conf?.twilio_conference_sid) return res.status(404).json({ ok: false });
  await getTwilio().conferences(conf.twilio_conference_sid).participants(part.twilio_call_sid).remove();
  await pool.query(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE id = $1`, [part.id]);
  void notifyConferenceState(conf.id, "conference.update", { pid: part.id, kicked: true });
  return res.json({ ok: true });
});

router.post("/conferences/:id/participants", auth, async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const conf = await getConferenceById(req.params.id);
  if (!conf) return res.status(404).json({ ok: false });
  const phoneRaw: string = req.body?.phone ?? "";
  const identity: string = req.body?.identity ?? "";
  if (phoneRaw) {
    const to = normalizeE164(phoneRaw);
    if (!to) return res.status(400).json({ ok: false, error: "invalid_phone" });
    const pid = await addParticipantRow({ conferenceId: conf.id, kind: "pstn", phoneNumber: to, displayName: req.body?.name ?? to });
    const sid = await dialPstnIntoConference({
      conferenceId: conf.id, conferenceFriendly: conf.friendly_name,
      toNumber: to, fromNumber: getCallerId(), participantId: pid,
    });
    return res.json({ ok: true, participantId: pid, callSid: sid });
  }
  if (identity) {
    const pid = await addParticipantRow({ conferenceId: conf.id, kind: "staff", identity, displayName: req.body?.name ?? identity });
    const sid = await dialClientIntoConference({ conferenceFriendly: conf.friendly_name, identity, participantId: pid });
    return res.json({ ok: true, participantId: pid, callSid: sid });
  }
  return res.status(400).json({ ok: false, error: "phone_or_identity_required" });
});

router.post("/calls/:callSid/dtmf", auth, async (req: any, res) => {
  const digits: string = String(req.body?.digits ?? "");
  if (!/^[0-9*#]+$/.test(digits)) return res.status(400).json({ ok: false, error: "invalid_digits" });
  await getTwilio().calls(req.params.callSid).update({ sendDigits: digits });
  return res.json({ ok: true });
});

router.post("/conferences/:id/recording", auth, async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const conf = await getConferenceById(req.params.id);
  if (!conf?.twilio_conference_sid) return res.status(404).json({ ok: false });
  const op: string = String(req.body?.op ?? ""); // "pause" | "resume" | "stop"
  if (!["pause", "resume", "stop"].includes(op)) return res.status(400).json({ ok: false, error: "invalid_op" });
  const recs = await getTwilio().conferences(conf.twilio_conference_sid).recordings.list({ limit: 1 });
  const rec = recs[0];
  if (!rec) return res.status(404).json({ ok: false, error: "no_recording" });
  const status = op === "pause" ? "paused" : op === "resume" ? "in-progress" : "stopped";
  await getTwilio().conferences(conf.twilio_conference_sid).recordings(rec.sid).update({ status });
  await pool.query(`UPDATE conferences SET recording_paused = $2, updated_at = now() WHERE id = $1`, [conf.id, op === "pause"]);
  void notifyConferenceState(conf.id, "recording.update", { op });
  return res.json({ ok: true });
});

router.post("/conferences/:id/transfer", auth, async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const conf = await getConferenceById(req.params.id);
  if (!conf) return res.status(404).json({ ok: false });
  const mode: string = String(req.body?.mode ?? "warm"); // "cold" | "warm"
  const target: any = req.body?.target ?? {};
  const initiatorPid: string = String(req.body?.initiatorParticipantId ?? "");
  let newPid: string | null = null;
  if (target.phone) {
    const to = normalizeE164(String(target.phone));
    if (!to) return res.status(400).json({ ok: false, error: "invalid_phone" });
    newPid = await addParticipantRow({ conferenceId: conf.id, kind: "pstn", phoneNumber: to, displayName: target.name ?? to });
    await dialPstnIntoConference({
      conferenceId: conf.id, conferenceFriendly: conf.friendly_name,
      toNumber: to, fromNumber: getCallerId(), participantId: newPid,
    });
  } else if (target.identity) {
    newPid = await addParticipantRow({ conferenceId: conf.id, kind: "staff", identity: target.identity, displayName: target.name ?? target.identity });
    await dialClientIntoConference({ conferenceFriendly: conf.friendly_name, identity: target.identity, participantId: newPid });
  } else {
    return res.status(400).json({ ok: false, error: "target_required" });
  }
  if (mode === "cold" && initiatorPid) {
    const part = await getParticipantById(initiatorPid);
    if (part?.twilio_call_sid && conf.twilio_conference_sid) {
      try {
        await getTwilio().conferences(conf.twilio_conference_sid).participants(part.twilio_call_sid).remove();
      } catch {}
    }
  }
  return res.json({ ok: true, newParticipantId: newPid });
});

export default router;
