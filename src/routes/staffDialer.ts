// BF_SERVER_v821_DIALER - small read/write surfaces for the iPhone dialler, its Siri Shortcuts and the Watch.
// Mounted ahead of "/staff" (that router requires STAFF_OVERVIEW for everything under it), each at its own path:
//   GET /api/staff/next-follow-up -> { found, taskId?, title?, contactId?, contactName?, phone? (E.164), dueAt? }
//   GET /api/staff/missed-summary -> { missedCalls: [{name, phone, at}], unreadMessages: [{name, contactId, preview, at, kind}],
//                                      voicemails: [{name, phone, at, excerpt}] }   (5 each)
//   GET /api/staff/call-hours     -> { enabled, timezone, weekly, urgentPassthrough, updatedAt }
//   PUT /api/staff/call-hours     { enabled, timezone, weekly, urgentPassthrough } -> the saved settings
// Everything is for the signed-in staff member only.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { toE164 } from "../voice/callerCard.js";
import { loadCallHours, saveCallHours, validateCallHoursInput } from "../voice/callHours.js";

const STAFF_ROLES = [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING];

function staffRouter(): Router {
  const r = Router();
  r.use(requireAuth);
  r.use(requireAuthorization({ roles: STAFF_ROLES }));
  return r;
}

function userIdOf(req: any): string {
  return String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "").trim();
}

function clip(value: unknown, max: number): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

// ---------------------------------------------------------------------------------------------------------------
// Next follow-up: the signed-in user's most urgent open task that has a callable contact. Overdue first (most
// overdue first), then due soonest, then undated; ties by priority, then age. Same tasks table as /api/tasks.
export const NEXT_FOLLOW_UP_SQL = `
  SELECT t.id::text AS task_id, t.title, t.due_at, t.contact_id::text AS contact_id,
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name,
         c.phone
    FROM tasks t
    JOIN contacts c ON c.id = t.contact_id
   WHERE t.assignee_user_id::text = $1
     AND t.deleted_at IS NULL
     AND t.status NOT IN ('COMPLETED', 'DEFERRED')
     AND c.phone IS NOT NULL
     AND length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 10
     AND c.merged_into_id IS NULL
   ORDER BY (t.due_at IS NOT NULL AND t.due_at < now()) DESC,
            t.due_at ASC NULLS LAST,
            CASE t.priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 WHEN 'LOW' THEN 2 ELSE 3 END,
            t.created_at ASC
   LIMIT 10`;

export const nextFollowUpRouter = staffRouter();
nextFollowUpRouter.get("/", safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: { code: "unauthenticated" } });
  const { rows } = await pool.query(NEXT_FOLLOW_UP_SQL, [userId]);
  // The SQL keeps only numbers with 10+ digits; the first that normalises to E.164 is the one to call.
  const row = rows.find((r: any) => toE164(r.phone));
  if (!row) return res.status(200).json({ found: false });
  return res.status(200).json({
    found: true,
    taskId: String(row.task_id),
    title: String(row.title ?? ""),
    contactId: String(row.contact_id),
    ...(row.contact_name ? { contactName: String(row.contact_name) } : {}),
    phone: toE164(row.phone),
    ...(row.due_at ? { dueAt: iso(row.due_at) } : {}),
  });
}));

// ---------------------------------------------------------------------------------------------------------------
// Missed summary ("what did I miss?"). Scope matches the existing surfaces:
//   missedCalls     - this user's "call_missed" bell notifications (direct line / named target / shared line), 24 h
//   unreadMessages  - unread inbound client SMS and portal messages in the active silo (the Communications unread)
//   voicemails      - the voicemail inbox scope (this user's own + unassigned, active silo), 24 h
export const MISSED_SUMMARY_LIMIT = 5;
export const MISSED_CALLS_SQL = `
  SELECT n.body, n.created_at, n.ref_id, cl.from_number, cl.phone_number
    FROM notifications n
    LEFT JOIN LATERAL (
      SELECT l.from_number, l.phone_number FROM call_logs l
       WHERE n.ref_table = 'calls' AND l.twilio_call_sid = n.ref_id
       ORDER BY l.created_at DESC LIMIT 1
    ) cl ON true
   WHERE n.user_id::text = $1
     AND n.type = 'call_missed'
     AND n.created_at > now() - interval '24 hours'
   ORDER BY n.created_at DESC
   LIMIT ${MISSED_SUMMARY_LIMIT}`;

export const UNREAD_MESSAGES_SQL = `
  SELECT DISTINCT ON (m.contact_id)
         m.contact_id::text AS contact_id, m.body, m.type, m.created_at, m.from_number,
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name
    FROM communications_messages m
    JOIN contacts c ON c.id = m.contact_id
   WHERE m.silo = $1
     AND m.direction = 'inbound'
     AND m.read_at IS NULL
     AND m.contact_id IS NOT NULL
     AND COALESCE(m.type, 'message') IN ('sms', 'message')
   ORDER BY m.contact_id, m.created_at DESC`;

export const VOICEMAILS_SQL = `
  SELECT v.created_at, v.from_number, COALESCE(v.transcript, v.transcription) AS transcript,
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name,
         c.phone AS contact_phone
    FROM voicemails v
    LEFT JOIN contacts c ON c.id = v.contact_id
   WHERE (c.silo = $1 OR c.silo IS NULL)
     AND (v.staff_user_id::text = $2 OR v.staff_user_id IS NULL)
     AND v.created_at > now() - interval '24 hours'
   ORDER BY v.created_at DESC
   LIMIT ${MISSED_SUMMARY_LIMIT}`;

/** "Missed call from Jane Client" -> "Jane Client". */
function missedCallLabel(body: unknown): string {
  return String(body ?? "").replace(/^missed call from\s+/i, "").trim();
}

export const missedSummaryRouter = staffRouter();
missedSummaryRouter.get("/", safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: { code: "unauthenticated" } });
  const silo = resolveSiloFromRequest(req);
  const [calls, messages, voicemails] = await Promise.all([
    pool.query(MISSED_CALLS_SQL, [userId]),
    // Newest thread first; DISTINCT ON needs the contact ordering, so the final order and cap are applied here.
    pool.query(`SELECT * FROM (${UNREAD_MESSAGES_SQL}) u ORDER BY u.created_at DESC LIMIT ${MISSED_SUMMARY_LIMIT}`, [silo]),
    pool.query(VOICEMAILS_SQL, [silo, userId]),
  ]);
  const missedCalls = calls.rows.map((r: any) => {
    const label = missedCallLabel(r.body);
    const phone = toE164(r.from_number) ?? toE164(r.phone_number) ?? toE164(label);
    return { name: label || phone || "Unknown caller", phone: phone ?? null, at: iso(r.created_at) };
  });
  const unreadMessages = messages.rows.map((r: any) => ({
    name: r.contact_name || toE164(r.from_number) || "Unknown",
    contactId: String(r.contact_id),
    preview: clip(r.body, 100),
    at: iso(r.created_at),
    kind: r.type === "sms" ? "sms" : "messages",
  }));
  const vms = voicemails.rows.map((r: any) => {
    const phone = toE164(r.contact_phone) ?? toE164(r.from_number);
    const name = r.contact_name && String(r.contact_name).toLowerCase() !== "unknown caller" ? String(r.contact_name) : (phone ?? "Unknown caller");
    return { name, phone: phone ?? null, at: iso(r.created_at), excerpt: clip(r.transcript, 100) };
  });
  return res.status(200).json({ missedCalls, unreadMessages, voicemails: vms });
}));

// ---------------------------------------------------------------------------------------------------------------
// Do-not-disturb by hours (staff_call_hours). GET returns the defaults (off) when nothing is saved.
export const callHoursRouter = staffRouter();
callHoursRouter.get("/", safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: { code: "unauthenticated" } });
  return res.status(200).json(await loadCallHours(pool, userId));
}));

callHoursRouter.put("/", safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: { code: "unauthenticated" } });
  const parsed = validateCallHoursInput(req.body);
  if (!parsed.ok) return res.status(400).json({ error: { code: parsed.error, message: parsed.message } });
  return res.status(200).json(await saveCallHours(pool, userId, parsed.value));
}));
