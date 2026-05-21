// BF_SERVER_BLOCK_v501_OUTBOUND_CORE_v1
// Staff-initiated outbound call entry. Creates conference, dials customer
// or staff target into it. Staff browser then joins via SDK using the
// conferenceFriendly we return.

import { Router } from "express";
import { auth } from "../middleware/auth.js";
import {
  createConference,
  addParticipantRow,
  dialPstnIntoConference,
  dialClientIntoConference,
} from "../voice/conferenceService.js";
import { getCallerId } from "../voice/twilioClient.js";

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

router.post("/calls", auth, async (req: any, res) => {
  const target = req.body ?? {};
  const userId: string = req.user?.userId || req.user?.id || req.user?.sub || "";
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });

  const silo = String(req.body?.silo || req.headers["x-silo"] || "BF").toUpperCase();
  const applicationId = target.applicationId ?? null;
  const contactId = target.contactId ?? null;

  // Mode A: PSTN  -> { to: "+1..." }
  // Mode B: staff -> { staffIdentity: "<user-uuid>" }
  let kind: "pstn" | "staff";
  let toPstn = "";
  let staffIdentity = "";
  if (target.staffIdentity && typeof target.staffIdentity === "string") {
    kind = "staff";
    staffIdentity = target.staffIdentity.trim();
  } else {
    toPstn = normalizeE164(target.to ?? "");
    if (!toPstn) return res.status(400).json({ ok: false, error: "invalid_to" });
    kind = "pstn";
  }

  try {
    const conf = await createConference({
      createdByUserId: userId,
      silo,
      direction: kind === "staff" ? "internal" : "outbound",
      applicationId,
      contactId,
    });

    // Caller participant row (staff in browser — joined when their SDK
    // hits the conference-join webhook).
    const callerPid = await addParticipantRow({
      conferenceId: conf.id,
      kind: "staff",
      identity: userId,
      role: "moderator",
      displayName: req.user?.name || req.user?.email || userId,
    });

    // Callee participant row + dial.
    if (kind === "pstn") {
      const callerId = getCallerId();
      if (!callerId) return res.status(503).json({ ok: false, error: "caller_id_unconfigured" });
      const calleePid = await addParticipantRow({
        conferenceId: conf.id,
        kind: "pstn",
        phoneNumber: toPstn,
        displayName: target.contactName ?? toPstn,
      });
      const calleeSid = await dialPstnIntoConference({
        conferenceId: conf.id,
        conferenceFriendly: conf.friendly_name,
        toNumber: toPstn,
        fromNumber: callerId,
        participantId: calleePid,
      });
      return res.json({
        ok: true,
        conferenceId: conf.id,
        conferenceFriendly: conf.friendly_name,
        callerParticipantId: callerPid,
        calleeParticipantId: calleePid,
        calleeCallSid: calleeSid,
      });
    } else {
      const calleePid = await addParticipantRow({
        conferenceId: conf.id,
        kind: "staff",
        identity: staffIdentity,
        displayName: target.contactName ?? staffIdentity,
      });
      const calleeSid = await dialClientIntoConference({
        conferenceFriendly: conf.friendly_name,
        identity: staffIdentity,
        participantId: calleePid,
      });
      return res.json({
        ok: true,
        conferenceId: conf.id,
        conferenceFriendly: conf.friendly_name,
        callerParticipantId: callerPid,
        calleeParticipantId: calleePid,
        calleeCallSid: calleeSid,
      });
    }
  } catch (e: any) {
    console.error("voice_calls_create_failed", { message: e?.message, code: e?.code });
    return res.status(500).json({ ok: false, error: "call_setup_failed", message: e?.message });
  }
});

router.get("/conferences/:id", auth, async (req, res) => {
  const { getConferenceById } = await import("../voice/conferenceService.js");
  const { pool } = await import("../db.js");
  const conf = await getConferenceById(req.params.id);
  if (!conf) return res.status(404).json({ ok: false, error: "not_found" });
  const parts = await pool.query(
    `SELECT * FROM conference_participants WHERE conference_id = $1 ORDER BY created_at`,
    [req.params.id],
  );
  return res.json({ ok: true, conference: conf, participants: parts.rows });
});

export default router;
