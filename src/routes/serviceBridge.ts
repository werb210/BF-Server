// BF_SERVER_SERVICE_BRIDGE_v1
// The three operations bi-server needs from BF-Server, and nothing else.
//
// bi-server previously called /api/sms (which does not exist) and
// /api/o365/mail/send (JWT-only), so BI sequences could not send. These
// endpoints replace both, behind the service token.
//
// Kept deliberately small: no application, lender or contact access. The one document
// read (v701) returns a single file, only for applications linked to BI.
// If BI needs something else later it gets added here explicitly rather than by
// widening the token's reach.
import { Router } from "express";
import { pool } from "../db.js";
import { requireServiceToken, SERVICE_USER_ID } from "../middleware/serviceToken.js";
import { sendSMS } from "../services/smsService.js";
import { sendViaGraph } from "../services/email/graphSendService.js";
import { getStorage } from "../lib/storage/index.js";
import { findActiveDocumentVersion } from "../modules/applications/applications.repo.js";

const router: Router = Router();
router.use(requireServiceToken);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// BF_SERVER_BI_DOC_FILE_v701 - BI-Server shows staff, and sends the carrier, documents it copied
// from BF; it only holds BF's storage pointer, so it fetches the file here. Read-only, one document,
// and only when the document's application is linked to BI (bi_public_id set).
router.get("/bi-documents/:id/file", async (req, res) => {
  const id = str(req.params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ ok: false, error: "invalid_document_id" });
  }
  try {
    const { rows } = await pool.query<{ filename: string | null; title: string | null; storage_key: string | null; blob_name: string | null; storage_path: string | null }>(
      `SELECT d.filename, d.title, d.storage_key, d.blob_name, d.storage_path
         FROM documents d JOIN applications a ON a.id::text = d.application_id::text
        WHERE d.id::text = $1 AND a.bi_public_id IS NOT NULL
        LIMIT 1`,
      [id],
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ ok: false, error: "not_found" });
    const version = await findActiveDocumentVersion({ documentId: id });
    const vmeta = version && version.metadata && typeof version.metadata === "object"
      ? (version.metadata as { storageKey?: string; mimeType?: string; fileName?: string }) : {};
    const key = vmeta.storageKey ?? doc.storage_key ?? doc.blob_name ?? doc.storage_path;
    if (!key) return res.status(404).json({ ok: false, error: "file_unavailable" });
    const file = await getStorage().get(key);
    if (!file) return res.status(404).json({ ok: false, error: "file_unavailable" });
    const name = String(vmeta.fileName ?? doc.filename ?? doc.title ?? "document").replace(/[^ -~]/g, "").replace(/"/g, "");
    res.setHeader("Content-Type", vmeta.mimeType ?? file.contentType ?? "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.setHeader("Cache-Control", "private, no-store");
    return res.send(file.buffer);
  } catch (err: any) {
    console.warn("[service] bi document file failed", { id, message: err?.message });
    return res.status(500).json({ ok: false, error: "file_read_failed" });
  }
});

router.post("/sms", async (req, res) => {
  const to = str(req.body?.to);
  const body = str(req.body?.body);
  if (!to || !body) { res.status(400).json({ ok: false, error: "to_and_body_required" }); return; }
  try {
    await sendSMS(to, body);
    await recordBridgeSmsOnTimeline(to, body);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "sms_failed" });
  }
});

router.post("/mail", async (req, res) => {
  const to = str(req.body?.to);
  const subject = str(req.body?.subject);
  if (!to || !subject) { res.status(400).json({ ok: false, error: "to_and_subject_required" }); return; }
  // BF_SERVER_BLOCK_v517_SERVICE_MAIL_AUDIT - BI sequence emails left no trace on
  // this side: no log line, and the caller never learned which mailbox was used
  // (an empty sendAs silently fell back to MS_GRAPH_SEND_AS, BF's submissions@).
  // Log every send with the mailbox, the recipient's domain and Microsoft's answer.
  const sentAs = (str(req.body?.sendAs) || String(process.env.MS_GRAPH_SEND_AS ?? "")).trim();
  const toDomain = to.includes("@") ? to.split("@").pop() : "unknown";
  const silo = String(req.get("X-Silo") ?? (req as any).user?.silo ?? "");
  const result = await sendViaGraph({
    to,
    subject,
    bodyHtml: str(req.body?.html) || undefined,
    // GraphSendInput requires bodyText even when HTML is supplied; Graph uses
    // bodyHtml when present and bodyText is the plain-text fallback.
    bodyText: str(req.body?.text),
    sendAs: str(req.body?.sendAs) || undefined,
  });
  if (!result.ok) {
    console.warn("[service-mail] send_failed", { silo, sentAs, toDomain, error: String(result.error).slice(0, 300) });
    res.status(502).json({ ok: false, error: result.error, sentAs });
    return;
  }
  console.info("[service-mail] accepted_by_microsoft", { silo, sentAs, toDomain });
  res.json({ ok: true, messageId: result.messageId ?? null, sentAs });
});

// BF_SERVER_BLOCK_v610_BI_THREAD - BI applicant thread. BI-Server authenticates the
// applicant and passes their phone in x-applicant-phone; the service token above is the
// trust boundary. contact_id is still accepted for callers that already have it.
const applicantPhone = (req: any) => str(req.header?.("x-applicant-phone") ?? req.body?.phone);
const q = (sql: string, params: unknown[]) => pool.query(sql, params as any[]) as any;

router.get("/applicant-messages", async (req, res) => {
  const phone = applicantPhone(req);
  if (!phone) { res.status(400).json({ ok: false, error: "applicant_phone_required" }); return; }
  try {
    const { biThreadForPhone } = await import("../services/biApplicantThread.js");
    const thread = await biThreadForPhone(q, phone);
    if (!thread) { res.status(400).json({ ok: false, error: "invalid_phone" }); return; }
    res.json(thread);
  } catch (err) {
    console.warn("[service-bridge] BI thread failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "thread_failed" });
  }
});

router.get("/applicant-messages/unread", async (req, res) => {
  const phone = applicantPhone(req);
  if (!phone) { res.status(400).json({ ok: false, error: "applicant_phone_required" }); return; }
  try {
    const { biUnreadForPhone } = await import("../services/biApplicantThread.js");
    res.json({ unreadCount: await biUnreadForPhone(q, phone) });
  } catch (err) {
    console.warn("[service-bridge] BI unread failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "unread_failed" });
  }
});

router.post("/applicant-messages/read", async (req, res) => {
  const phone = applicantPhone(req);
  if (!phone) { res.status(400).json({ ok: false, error: "applicant_phone_required" }); return; }
  try {
    const { biMarkReadForPhone } = await import("../services/biApplicantThread.js");
    res.json({ ok: true, marked: await biMarkReadForPhone(q, phone) });
  } catch (err) {
    console.warn("[service-bridge] BI mark-read failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "read_failed" });
  }
});

router.post("/applicant-messages", async (req, res) => {
  const phone = applicantPhone(req);
  const body = str(req.body?.body ?? req.body?.message).slice(0, 4000);
  try {
    const { biSendForPhone, cleanAttachments } = await import("../services/biApplicantThread.js");
    const attachments = cleanAttachments(req.body?.attachments);
    if (!phone || (!body && attachments.length === 0)) { res.status(400).json({ ok: false, error: "phone_and_body_required" }); return; }
    const message = await biSendForPhone(q, phone, body, attachments);
    if (!message) { res.status(400).json({ ok: false, error: "invalid_phone" }); return; }
    void import("../services/biApplicantThread.js").then((t) => t.biContactForPhone(q, phone)).then((contactId) => {
      // BF_SERVER_BLOCK_v619 - automation trigger.
      if (contactId) void import("../modules/automation/automationEngine.js").then((m) => m.emitAutomationEvent({ trigger: "message.inbound", silo: "BI", contactId, data: { channel: "app" } }));
    }).catch((err: any) => console.warn("[automation] emit failed", err?.message ?? String(err)));
    res.status(201).json({ ok: true, message_id: message.id, ...message });
  } catch (err) {
    console.warn("[service-bridge] BI applicant message failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "message_insert_failed" });
  }
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

// BF_SERVER_TIMELINE_EVERY_CHANNEL_v358 - BI sequence SMS on the contact timeline.
async function recordBridgeSmsOnTimeline(to: string, body: string): Promise<void> {
  try {
    const digits = to.replace(/\D/g, "");
    if (digits.length < 7) return;
    const { pool } = await import("../db.js");
    await pool.query(
      `INSERT INTO crm_timeline_events (contact_id, event_type, payload)
       SELECT c.id, 'sms_marketing_sent', $2::jsonb FROM contacts c
        WHERE c.phone IS NOT NULL AND regexp_replace(c.phone, '\\D', '', 'g') = $1`,
      [digits, JSON.stringify({ body, source: "bi_sequence" })],
    );
  } catch (err) {
    console.warn("[service-bridge] timeline record failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
