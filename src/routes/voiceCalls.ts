// BF_SERVER_BLOCK_v501_OUTBOUND_CORE_v1
// Staff-initiated outbound call entry. Creates conference, dials customer
// or staff target into it. Staff browser then joins via SDK using the
// conferenceFriendly we return.

import { Router } from "express";
import { auth } from "../middleware/auth.js";
import { pool } from "../db.js";

// BF_SERVER_BLOCK_CALL_CONTACT_RESOLVE_v1 — resolve the CRM contact for a dialed
// call when the client did not send one. Order: explicit contactId -> the
// application's crm_contact_id -> an existing contact by phone (last-10,
// silo-scoped). Never creates a contact. Pure + unit-tested.
type QueryRunner = (text: string, params: unknown[]) => Promise<{ rows: any[] }>;
export async function resolveCallContactId(
  q: QueryRunner,
  args: { contactId: string | null; applicationId: string | null; toPstn: string; silo: string },
): Promise<string | null> {
  if (args.contactId) return args.contactId;
  if (args.applicationId) {
    const ar = await q(
      `SELECT crm_contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [args.applicationId],
    ).catch(() => ({ rows: [] as any[] }));
    const cid = (ar.rows[0]?.crm_contact_id as string | null | undefined) ?? null;
    if (cid) return cid;
  }
  if (args.toPstn) {
    const digits = args.toPstn.replace(/[^0-9]/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    if (last10) {
      const cr = await q(
        `SELECT id FROM contacts
           WHERE silo = $2 AND phone IS NOT NULL
             AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
             AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
           ORDER BY created_at ASC LIMIT 1`,
        [last10, args.silo],
      ).catch(() => ({ rows: [] as any[] }));
      return (cr.rows[0]?.id as string | undefined) ?? null;
    }
  }
  return null;
}
import {
  createConference,
  addParticipantRow,
  dialPstnIntoConference,
  dialClientIntoConference,
} from "../voice/conferenceService.js";
import { getCallerId } from "../voice/twilioClient.js";
import voiceMidCallRoutes from "./voiceMidCall.js";

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

// BF_SERVER_CALLER_RESOLVE_v1 — resolve an inbound caller's number to a CRM
// contact (name + id + most-recent application) so the incoming-call toast
// shows who is calling and staff can open the contact mid-call. Read-only.
router.post("/resolve-caller", auth, async (req: any, res) => {
  const raw = typeof req.body?.phone === "string" ? req.body.phone : "";
  const phone10 = raw.replace(/[^0-9]/g, "").slice(-10);
  if (phone10.length < 10) return res.json({ ok: true, matched: false, name: null });
  try {
    const { rows } = await pool.query(
      `SELECT c.id::text AS contact_id, c.name,
              coalesce(c.company_name, '') AS company,
              (SELECT a.id::text FROM applications a WHERE a.contact_id = c.id ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) AS application_id,
              (SELECT a.name FROM applications a WHERE a.contact_id = c.id ORDER BY a.updated_at DESC NULLS LAST LIMIT 1) AS application_name
         FROM contacts c
        WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
        ORDER BY c.updated_at DESC NULLS LAST LIMIT 1`,
      [phone10],
    );
    const r = rows[0];
    if (!r) return res.json({ ok: true, matched: false, name: null });
    const display = (r.name && String(r.name).trim()) || (r.company && String(r.company).trim()) || null;
    return res.json({ ok: true, matched: true, name: display, contactId: r.contact_id, companyName: r.company || null, applicationId: r.application_id || null, applicationName: r.application_name || null });
  } catch {
    return res.json({ ok: true, matched: false, name: null });
  }
});

// BF_SERVER_RECENT_CALLS_v1 - recent calls for the logged-in staff member, newest
// first, with the resolved contact name. Powers the dialer "Recents" list.
router.get("/recent-calls", auth, async (req: any, res) => {
  const userId = req.user?.userId ?? req.user?.id ?? null;
  if (!userId) return res.json({ ok: true, items: [] });
  const r = await pool
    .query(
      `SELECT id, direction, status, duration_seconds, created_at, phone_number, contact_id, contact_name
         FROM (
           SELECT cl.id::text AS id, cl.direction, cl.status, cl.duration_seconds, cl.created_at,
                  cl.phone_number, cl.crm_contact_id AS contact_id, c.name AS contact_name,
                  cl.twilio_call_sid AS sid
             FROM call_logs cl
             LEFT JOIN contacts c ON c.id = cl.crm_contact_id
            -- BF_SERVER_INBOUND_RECENTS_v1 - inbound PSTN calls are logged with
            -- staff_user_id = NULL (nobody owns a call to the main line until it is
            -- answered), so this filter silently hid EVERY incoming call. Inbound
            -- calls to the shared line are visible to all staff.
            WHERE (cl.staff_user_id = $1
                   OR (cl.direction = 'inbound' AND cl.staff_user_id IS NULL))
           UNION ALL
           -- BF_SERVER_BLOCK_v_OUTBOUND_RECENTS_UNION_v1 - outbound calls placed via
           -- the web dialer are recorded in crm_call_log; the conference/status
           -- webhook path that writes call_logs is unreliable, which left the Phone
           -- "Outgoing" column empty after May 2026. Surface those outbound calls
           -- here so Outgoing matches Incoming. Dedup against call_logs by call sid.
           SELECT ccl.id::text AS id, ccl.direction, 'completed'::text AS status,
                  ccl.duration_sec AS duration_seconds, ccl.created_at,
                  ccl.to_number AS phone_number, ccl.contact_id, c2.name AS contact_name,
                  ccl.twilio_call_sid AS sid
             FROM crm_call_log ccl
             LEFT JOIN contacts c2 ON c2.id = ccl.contact_id
            WHERE ccl.owner_id = $1
              AND ccl.direction = 'outbound'
              AND (ccl.twilio_call_sid IS NULL
                   OR ccl.twilio_call_sid NOT IN (
                     SELECT twilio_call_sid FROM call_logs WHERE twilio_call_sid IS NOT NULL))
         ) merged
        ORDER BY created_at DESC
        LIMIT 50`,
      [userId],
    )
    .catch(() => ({ rows: [] as any[] }));
  return res.json({ ok: true, items: r.rows ?? [] });
});

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
    const resolvedContactId = await resolveCallContactId(
      (text, params) => pool.query(text, params),
      { contactId, applicationId, toPstn, silo },
    );
    const conf = await createConference({
      createdByUserId: userId,
      silo,
      direction: kind === "staff" ? "internal" : "outbound",
      applicationId,
      contactId: resolvedContactId,
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

// v504b -- mid-call endpoints live on the same /voice mount
router.use("/", voiceMidCallRoutes);

export default router;
