// BF_SERVER_BLOCK_v504_MIDCALL_CONTROLS_v1
import { prepareMultiParty } from "../voice/multiParty.js"; // BF_SERVER_v830_DIALER_CONTROLS
import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { pool } from "../db.js";
import { callerIdForUser } from "../voice/directLines.js"; // BF_SERVER_PHONE_ROUTING_v688b
import { getTwilio, getCallerId, getPublicBaseUrl } from "../voice/twilioClient.js";
import {
  getConferenceById, getParticipantById, addParticipantRow,
  dialPstnIntoConference, dialClientIntoConference, notifyConferenceState,
  getParticipantBySid, // BF_SERVER_v830_DIALER_CONTROLS
} from "../voice/conferenceService.js";
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS

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

router.post("/conferences/:id/participants/:pid/mute", auth, safeHandler(async (req: any, res) => {
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
}));

router.post("/conferences/:id/participants/:pid/hold", auth, safeHandler(async (req: any, res) => {
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
}));

router.delete("/conferences/:id/participants/:pid", auth, safeHandler(async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const part = await getParticipantById(req.params.pid);
  const conf = await getConferenceById(req.params.id);
  if (!part || !conf?.twilio_conference_sid) return res.status(404).json({ ok: false });
  await getTwilio().conferences(conf.twilio_conference_sid).participants(part.twilio_call_sid).remove();
  await pool.query(`UPDATE conference_participants SET status = 'left', left_at = now() WHERE id = $1`, [part.id]);
  void notifyConferenceState(conf.id, "conference.update", { pid: part.id, kicked: true });
  return res.json({ ok: true });
}));

router.post("/conferences/:id/participants", auth, safeHandler(async (req: any, res) => {
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
    await prepareMultiParty(conf.id); // BF_SERVER_v830_DIALER_CONTROLS - the people already on the call stay when one leaves
    const sid = await dialPstnIntoConference({
      multiParty: true,
      conferenceId: conf.id, conferenceFriendly: conf.friendly_name,
      toNumber: to, fromNumber: await callerIdForUser(pool, req.user?.userId || req.user?.id || req.user?.sub || ""), participantId: pid, // BF_SERVER_PHONE_ROUTING_v688b (v789: participantId was inside this comment)
    });
    return res.json({ ok: true, participantId: pid, callSid: sid });
  }
  if (identity) {
    const pid = await addParticipantRow({ conferenceId: conf.id, kind: "staff", identity, displayName: req.body?.name ?? identity });
    await prepareMultiParty(conf.id); // BF_SERVER_v830_DIALER_CONTROLS
    const sid = await dialClientIntoConference({ multiParty: true, conferenceFriendly: conf.friendly_name, identity, participantId: pid });
    return res.json({ ok: true, participantId: pid, callSid: sid });
  }
  return res.status(400).json({ ok: false, error: "phone_or_identity_required" });
}));

// BF_SERVER_v830_DIALER_CONTROLS - keypad tones to someone on a Boreal (conference) call: phone menus, extensions,
// PINs. A conference does not pass one participant's tones to another, and Twilio's call update has no sendDigits, so
// tones typed on the dialler never reached the other side. The tones are played to that participant's own leg as an
// announcement (<Play digits>), which their phone system hears.
//   POST /api/voice/conferences/:id/participants/:pid/dtmf { digits }   (0-9 * # and w for a half-second pause)
router.post("/conferences/:id/participants/:pid/dtmf", auth, safeHandler(async (req: any, res) => {
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  const { validTones, sendTonesToParticipant } = await import("../voice/conferenceTones.js");
  const digits = String(req.body?.digits ?? "");
  if (!validTones(digits)) return res.status(400).json({ ok: false, error: "invalid_digits" });
  if (!await userMaySee(userId, req.params.id)) return res.status(403).json({ ok: false });
  const part = await getParticipantById(req.params.pid);
  const conf = await getConferenceById(req.params.id);
  if (!part?.twilio_call_sid || part.conference_id !== conf?.id || !conf?.twilio_conference_sid) return res.status(404).json({ ok: false, error: "not_on_call" });
  await sendTonesToParticipant(getTwilio() as any, conf.twilio_conference_sid, part.twilio_call_sid, digits);
  return res.json({ ok: true });
}));

router.post("/calls/:callSid/dtmf", auth, safeHandler(async (req: any, res) => {
  const digits: string = String(req.body?.digits ?? "");
  if (!/^[0-9*#]+$/.test(digits)) return res.status(400).json({ ok: false, error: "invalid_digits" });
  // BF_SERVER_v830_DIALER_CONTROLS - a leg in a conference gets the tones as an announcement (see above); Twilio's call
  // update has no sendDigits, so the old call update never sent anything.
  const userId = req.user?.userId || req.user?.id || req.user?.sub || "";
  const part = await getParticipantBySid(String(req.params.callSid));
  if (part) {
    const conf = await getConferenceById(part.conference_id);
    if (conf?.twilio_conference_sid && await userMaySee(userId, conf.id)) {
      const { sendTonesToParticipant } = await import("../voice/conferenceTones.js");
      await sendTonesToParticipant(getTwilio() as any, conf.twilio_conference_sid, String(req.params.callSid), digits);
      return res.json({ ok: true });
    }
  }
  return res.status(404).json({ ok: false, error: "not_on_call" });
}));

router.post("/conferences/:id/recording", auth, safeHandler(async (req: any, res) => {
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
}));

router.post("/conferences/:id/transfer", auth, safeHandler(async (req: any, res) => {
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
    await prepareMultiParty(conf.id); // BF_SERVER_v830_DIALER_CONTROLS - a transfer must not end the customer's call
    await dialPstnIntoConference({
      multiParty: true,
      conferenceId: conf.id, conferenceFriendly: conf.friendly_name,
      toNumber: to, fromNumber: await callerIdForUser(pool, req.user?.userId || req.user?.id || req.user?.sub || ""), participantId: newPid, // BF_SERVER_PHONE_ROUTING_v688b (v789: participantId was inside this comment)
    });
  } else if (target.identity) {
    newPid = await addParticipantRow({ conferenceId: conf.id, kind: "staff", identity: target.identity, displayName: target.name ?? target.identity });
    await prepareMultiParty(conf.id); // BF_SERVER_v830_DIALER_CONTROLS
    await dialClientIntoConference({ multiParty: true, conferenceFriendly: conf.friendly_name, identity: target.identity, participantId: newPid });
  } else {
    return res.status(400).json({ ok: false, error: "target_required" });
  }
  if (mode === "cold" && initiatorPid) {
    const part = await getParticipantById(initiatorPid);
    if (part?.twilio_call_sid && conf.twilio_conference_sid) {
      try {
        await getTwilio().conferences(conf.twilio_conference_sid).participants(part.twilio_call_sid).remove();
      } catch (err: any) {
        console.warn("[transfer] could not remove the transferring leg", { conferenceId: conf.id, message: err?.message });
      }
    }
  }
  return res.json({ ok: true, newParticipantId: newPid });
}));

export default router;
