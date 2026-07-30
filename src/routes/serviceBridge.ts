// BF_SERVER_SERVICE_BRIDGE_v1
// The three operations bi-server needs from BF-Server, and nothing else.
//
// bi-server previously called /api/sms (which does not exist) and
// /api/o365/mail/send (JWT-only), so BI sequences could not send. These
// endpoints replace both, behind the service token.
//
// Kept deliberately small: no application, document, lender or contact access.
// If BI needs something else later it gets added here explicitly rather than by
// widening the token's reach.
import { Router } from "express";
import { pool } from "../db.js";
import { requireServiceToken, SERVICE_USER_ID } from "../middleware/serviceToken.js";
import { sendSMS } from "../services/smsService.js";
import { sendViaGraph } from "../services/email/graphSendService.js";

const router: Router = Router();
router.use(requireServiceToken);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

router.post("/sms", async (req, res) => {
  const to = str(req.body?.to);
  const body = str(req.body?.body);
  if (!to || !body) { res.status(400).json({ ok: false, error: "to_and_body_required" }); return; }
  try {
    await sendSMS(to, body);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "sms_failed" });
  }
});

router.post("/mail", async (req, res) => {
  const to = str(req.body?.to);
  const subject = str(req.body?.subject);
  if (!to || !subject) { res.status(400).json({ ok: false, error: "to_and_subject_required" }); return; }
  const result = await sendViaGraph({
    to,
    subject,
    bodyHtml: str(req.body?.html) || undefined,
    // GraphSendInput requires bodyText even when HTML is supplied; Graph uses
    // bodyHtml when present and bodyText is the plain-text fallback.
    bodyText: str(req.body?.text),
    sendAs: str(req.body?.sendAs) || undefined,
  });
  if (!result.ok) { res.status(502).json({ ok: false, error: result.error }); return; }
  res.json({ ok: true, messageId: result.messageId ?? null });
});

// BI sequence task steps land in the assignee's BF task list. The silo comes
// from the X-Silo header the service token already read, so a BI task is filed
// as BI and shows in that silo's task views rather than leaking into BF's.
router.post("/tasks", async (req, res) => {
  const title = str(req.body?.title);
  if (!title) { res.status(400).json({ ok: false, error: "title_required" }); return; }
  const assignee = str(req.body?.assignee_user_id) || SERVICE_USER_ID;
  const silo = String((req as any).user?.silo ?? "BF");
  const type = ["CALL", "EMAIL", "SMS", "TODO"].includes(str(req.body?.type)) ? str(req.body?.type) : "TODO";
  const priority = ["NONE", "LOW", "MEDIUM", "HIGH"].includes(str(req.body?.priority)) ? str(req.body?.priority) : "NONE";
  try {
    const inserted = await pool.query<{ id: string }>(
      // Column is `body`, not `notes`, and the status enum starts at
      // NOT_STARTED — checked against migrations/2026_07_04_tasks_v1.sql rather
      // than assumed.
      `INSERT INTO tasks (id, title, body, type, priority, status, silo, assignee_user_id, created_by, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'NOT_STARTED', $5, $6, $7, now(), now())
       RETURNING id`,
      [title, str(req.body?.notes) || null, type, priority, silo, assignee, SERVICE_USER_ID],
    );
    res.status(201).json({ ok: true, task_id: inserted.rows[0]?.id ?? null, assignee_user_id: assignee, silo });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "task_insert_failed" });
  }
});

// Staff directory for the BI sequence builder's assignee dropdown. Id and name
// only — this is a picker, not a user export.
router.get("/staff", async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT id::text AS id,
              NULLIF(trim(concat_ws(' ', first_name, last_name)), '') AS name,
              email
         FROM users
        WHERE active = true
        ORDER BY first_name ASC NULLS LAST, last_name ASC NULLS LAST`,
    );
    res.json({ ok: true, staff: rows.rows.map((r: any) => ({ id: r.id, name: r.name || r.email })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : "staff_query_failed" });
  }
});

export default router;
