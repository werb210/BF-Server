import { Router } from "express";
import { pool } from "../db.js";
import { sendSMS } from "../lib/twilio.js"; // BF_SERVER_WATCH_SMS_v1
import { allowedLine, watchAuth, watchError } from "./security.js";
// BF_SERVER_CALL_DISPOSITION_v145
import { CALL_DISPOSITIONS as SHARED_CALL_DISPOSITIONS, followUpFor } from "../modules/calls/callDisposition.js";

const router = Router();
router.use(watchAuth);
const bounded = (value: unknown, fallback: number, max: number) => Math.max(1, Math.min(max, Number.parseInt(String(value || fallback), 10) || fallback));

router.get("/contacts", async (req, res) => {
  const requested = String(req.query.line || "").toUpperCase();
  const line = allowedLine(req, requested);
  if (!line) return watchError(req, res, ["BF", "BI", "SLF"].includes(requested) ? 403 : 400,
    ["BF", "BI", "SLF"].includes(requested) ? "forbidden" : "invalid_request", "Line is invalid or not permitted");
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 100) : "";
  if (q.length < 2) return watchError(req, res, 400, "invalid_request", "Search query must contain at least two characters");
  const limit = bounded(req.query.limit, 10, 25);
  const cursor = typeof req.query.cursor === "string" && /^[0-9a-f-]{36}$/i.test(req.query.cursor) ? req.query.cursor : null;
  const found = await pool.query(
    `SELECT id::text,name,company_name AS company,phone AS "primaryPhone" FROM contacts
      WHERE silo=$1 AND ($2::uuid IS NULL OR id>$2::uuid)
        AND (name ILIKE '%'||$3||'%' OR company_name ILIKE '%'||$3||'%' OR phone ILIKE '%'||$3||'%')
        AND phone IS NOT NULL ORDER BY id ASC LIMIT $4`, [line, cursor, q, limit + 1]);
  const more = found.rows.length > limit;
  const items = found.rows.slice(0, limit);
  return res.json({ items, nextCursor: more ? items.at(-1)?.id : null });
});

router.get("/calls/recent", async (req: any, res) => {
  const requested = String(req.query.line || "").toUpperCase();
  const line = allowedLine(req, requested);
  if (!line) return watchError(req, res, ["BF", "BI", "SLF"].includes(requested) ? 403 : 400,
    ["BF", "BI", "SLF"].includes(requested) ? "forbidden" : "invalid_request", "Line is invalid or not permitted");
  const limit = bounded(req.query.limit, 25, 50);
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const found = await pool.query(
    `SELECT cl.id::text AS id,cl.phone_number AS number,c.name AS "contactName",cl.direction,
            cl.created_at AS "occurredAt",cl.silo AS line,cl.status
       FROM call_logs cl LEFT JOIN contacts c ON c.id=cl.crm_contact_id AND c.silo=cl.silo
      WHERE cl.staff_user_id=$1 AND cl.silo=$2 AND ($3::timestamptz IS NULL OR cl.created_at<$3::timestamptz)
      ORDER BY cl.created_at DESC,cl.id DESC LIMIT $4`, [req.watch.staffUserId, line, cursor, limit + 1]);
  const more = found.rows.length > limit;
  const items = found.rows.slice(0, limit);
  return res.json({ items, nextCursor: more ? new Date(items.at(-1).occurredAt).toISOString() : null });
});

// BF_SERVER_WATCH_CALL_DISPOSITION_v1 - record a post-call outcome from the Watch.
// BF_SERVER_CALL_DISPOSITION_v145 - shared with the dialer and staff portal.
const CALL_DISPOSITIONS = new Set<string>(SHARED_CALL_DISPOSITIONS);
router.post("/calls/:id/disposition", async (req: any, res) => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) return watchError(req, res, 400, "invalid_request", "Invalid call id");
  const disposition = String(req.body?.disposition || "");
  if (!CALL_DISPOSITIONS.has(disposition)) return watchError(req, res, 400, "invalid_request", "Unknown disposition");
  const updated = await pool.query(
    `UPDATE call_logs SET disposition=$1 WHERE id=$2::uuid AND staff_user_id=$3 RETURNING id::text, COALESCE(contact_id, crm_contact_id) AS contact_id, silo`,
    [disposition, id, req.watch.staffUserId]);
  if (!updated.rowCount) return watchError(req, res, 404, "not_found", "Call not found");
  // BF_SERVER_DISPOSITION_TASK_v1 - on actionable outcomes, auto-create a follow-up
  // task for the contact (deduped by call id so re-dispositioning won't stack tasks).
  const row: any = updated.rows[0];
  const rule = followUpFor(disposition);
  if (rule && row?.contact_id) {
    await pool.query(
      `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source, source_ref_id)
       SELECT $1, $2, $3, 'TODO', 'MEDIUM', now() + ($4 || ' days')::interval, $5::uuid, $6::uuid, 'CALL_DISPOSITION', $7::uuid
        WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE source = 'CALL_DISPOSITION' AND source_ref_id = $7::uuid)`,
      [row.silo, rule.label, `Auto-created from call outcome: ${disposition}`, String(rule.days), req.watch.staffUserId, row.contact_id, id]);
  }
  // BF_SERVER_DISPOSITION_NOTE_v1 - record every outcome on the contact timeline (best-effort).
  if (row?.contact_id) {
    await pool.query(
      `INSERT INTO crm_notes (body, contact_id, silo) VALUES ($1, $2::uuid, $3)`,
      [`Call outcome: ${disposition.replace(/_/g, " ")}`, row.contact_id, row.silo]).catch(() => {});
  }
  return res.json({ id, disposition });
});

// BF_SERVER_WATCH_SMS_v1 - quick text from the wrist: list SMS templates/snippets + send.
router.get("/sms-templates", async (req: any, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id::text, name, COALESCE(body_text, '') AS body
         FROM message_templates
        WHERE channel IN ('sms', 'message') AND (shared = true OR owner_user_id = $1)
        ORDER BY name ASC LIMIT 50`,
      [req.watch.staffUserId]);
    return res.json({ templates: rows });
  } catch {
    return res.json({ templates: [] });
  }
});

router.post("/sms", async (req: any, res) => {
  const to = String(req.body?.to || "").trim();
  const body = String(req.body?.body || "").trim();
  if (!to || !body) return watchError(req, res, 400, "invalid_request", "to and body are required");
  try {
    await sendSMS(to, body);
  } catch {
    return watchError(req, res, 502, "send_failed", "Could not send the message");
  }
  return res.json({ ok: true });
});

export default router;
