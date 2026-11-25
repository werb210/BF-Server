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
import { safeHandler } from "../middleware/safeHandler.js"; // BF_SERVER_v789_SAFE_HANDLERS

const router: Router = Router();
router.use(requireServiceToken);

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// BF_SERVER_SERVICE_COLLATERAL_v1 - BI-Server attaches collateral PDFs (Settings > Content > Collateral) to its
// marketing flow emails. Read-only: the list (names and sizes) and one file at a time.
router.get("/collateral", safeHandler(async (_req: any, res: any) => {
  const { rows } = await pool.query(
    `SELECT id, name, content_type, size_bytes, silo, created_at FROM collateral_assets ORDER BY created_at DESC`,
  );
  res.json({ ok: true, items: rows });
}));

router.get("/collateral/:id/file", safeHandler(async (req: any, res: any) => {
  const id = str(req.params.id);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ ok: false, error: "invalid_collateral_id" });
  }
  const { rows } = await pool.query(`SELECT name, content_type, blob_name FROM collateral_assets WHERE id::text = $1 LIMIT 1`, [id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ ok: false, error: "not_found" });
  const file = await getStorage().get(row.blob_name);
  if (!file) return res.status(404).json({ ok: false, error: "file_unavailable" });
  const name = String(row.name ?? "document").replace(/[^ -~]/g, "").replace(/"/g, "");
  res.setHeader("Content-Type", row.content_type || file.contentType || "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${name}"`);
  res.setHeader("Cache-Control", "private, no-store");
  return res.send(file.buffer);
}));

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
    await sendSMS(to, body, { silo: "BI" }); // BF_SERVER_RCS_BRAND_BF_ONLY_v781 - this bridge is BI-Server's
    await recordBridgeSmsOnTimeline(to, body);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "sms_failed" });
  }
});

router.post("/mail", safeHandler(async (req, res) => {
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
}));

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
      if (contactId) void import("../modules/automation/automationEngine.js").then((m) => m.emitAutomationEvent({ trigger: "message.inbound", silo: "BI", contactId, data: { channel: "client_portal" } }));
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
// BF_SERVER_v968_PGI_REP_AGREEMENT - BI-Server has no SignNow account of its own. When staff add an outside PGI rep
// it asks here for the Introducer Agreement to be issued, for a fresh signing link when the rep opens their page,
// and whether it has been signed. Nothing about the rep is stored on this server.
const repStr = (v: unknown, max: number): string => str(v).replace(/\s+/g, " ").slice(0, max);
// BF_SERVER_BRAND_ONLY_UNSUBSCRIBES_v1 - BI-Server moved these Boreal Risk Management unsubscribes off SendGrid's
// account-wide list onto BRM's own group (Todd's rule: unsubscribing from one brand does not stop the others). Mark our copy
// as that brand only, and lift the Keystone / Boreal Financial opt-outs it caused, unless something else still applies
// (a bounce, a spam report, an unsubscribe from that business).
router.post("/suppressions/brand-only", safeHandler(async (req, res) => {
  const brand = String(req.body?.brand ?? "").toUpperCase();
  if (!["BI", "KS", "BF", "SLF"].includes(brand)) return res.status(400).json({ ok: false, error: "bad_brand" });
  const emails = Array.from(new Set((Array.isArray(req.body?.emails) ? req.body.emails : [])
    .map((e: unknown) => String(e ?? "").trim().toLowerCase()).filter((e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))).slice(0, 2000);
  if (!emails.length) return res.json({ ok: true, marked: 0, released: 0 });
  const marked = await pool.query(
    `UPDATE email_suppressions SET brands = ARRAY[$2]::text[]
      WHERE email = ANY($1::text[]) AND brands IS NULL AND reason IN ('unsubscribe', 'group_unsubscribe', 'sendgrid_unsubscribe')`,
    [emails, brand],
  );
  const released = await pool.query(
    `UPDATE contacts c SET marketing_opt_out = false, updated_at = now()
      WHERE c.marketing_opt_out = true
        AND (lower(btrim(coalesce(c.email, ''))) = ANY($1::text[]) OR lower(btrim(coalesce(c.secondary_email, ''))) = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM email_suppressions s
                         WHERE s.email IN (lower(btrim(coalesce(c.email, ''))), lower(btrim(coalesce(c.secondary_email, '')))) AND s.email <> ''
                           AND (s.brands IS NULL OR coalesce(c.silo, 'BF') = ANY (s.brands)))
      RETURNING c.id`,
    [emails],
  );
  console.log("[service] brand-only unsubscribes", { brand, emails: emails.length, marked: marked.rowCount, released: released.rowCount });
  return res.json({ ok: true, marked: marked.rowCount ?? 0, released: released.rowCount ?? 0 });
}));

router.post("/pgi-rep-agreement", safeHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const fullName = repStr(b.fullName, 120);
  const email = repStr(b.email, 200).toLowerCase();
  const repId = repStr(b.repId, 64);
  if (!fullName || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || !repId) return res.status(400).json({ ok: false, error: "name_email_and_rep_required" });
  const sn = await import("../signnow/signnowClient.js");
  if (!sn.isApiKeyConfigured()) return res.status(503).json({ ok: false, error: "signing_not_configured" });
  const { buildPgiRepAgreementPdf, PGI_REP_AGREEMENT_VERSION } = await import("../signnow/pgiRepAgreementPdfBuilder.js");
  const pdf = await buildPgiRepAgreementPdf({ fullName, email, company: repStr(b.company, 160) || null, phone: repStr(b.phone, 40) || null });
  const { documentId } = await sn.uploadDocumentWithFieldExtract(pdf, `Boreal Risk Management Introducer Agreement - ${fullName} - ${repId}.pdf`);
  const { groupId } = await sn.createDocumentGroup([documentId], `PGI Introducer Agreement ${repId}`);
  const { inviteId } = await sn.createEmbeddedGroupInvite(groupId, [documentId], [{ email, name: fullName, roleName: "Rep" }]);
  console.log("[service] pgi rep agreement issued", { repId, version: PGI_REP_AGREEMENT_VERSION });
  return res.status(201).json({ ok: true, groupId, inviteId, documentId, version: PGI_REP_AGREEMENT_VERSION });
}));
router.post("/pgi-rep-agreement/link", safeHandler(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const groupId = repStr(b.groupId, 80), inviteId = repStr(b.inviteId, 80), email = repStr(b.email, 200).toLowerCase();
  if (!groupId || !inviteId || !email) return res.status(400).json({ ok: false, error: "group_invite_and_email_required" });
  const sn = await import("../signnow/signnowClient.js");
  if (!sn.isApiKeyConfigured()) return res.status(503).json({ ok: false, error: "signing_not_configured" });
  const status = await sn.getDocumentGroupStatus(groupId);
  if (status.signed) return res.json({ ok: true, signed: true, url: null });
  const { url } = await sn.createEmbeddedGroupLink(groupId, inviteId, email);
  return res.json({ ok: true, signed: false, url });
}));
router.get("/pgi-rep-agreement/:groupId/status", safeHandler(async (req, res) => {
  const groupId = repStr(req.params.groupId, 80);
  const sn = await import("../signnow/signnowClient.js");
  if (!sn.isApiKeyConfigured()) return res.status(503).json({ ok: false, error: "signing_not_configured" });
  const status = await sn.getDocumentGroupStatus(groupId);
  return res.json({ ok: true, signed: status.signed });
}));

// BF_SERVER_v976_SERVICE_MAIL_REPLIES - who has emailed a staff mailbox since a time, so BI-Server can stop an email
// flow when a person replies. Read-only: sender address and time, never the message. The mailbox must be a staff
// user whose Microsoft 365 is connected; otherwise { connected: false }.
router.get("/mail/replies", safeHandler(async (req: any, res: any) => {
  const mailbox = str(req.query.mailbox).toLowerCase();
  const sinceRaw = new Date(str(req.query.since));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mailbox)) return res.status(400).json({ ok: false, error: "bad_mailbox" });
  const since = Number.isNaN(sinceRaw.getTime()) ? new Date(Date.now() - 24 * 3_600_000) : sinceRaw;
  const u = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE lower(email) = $1 AND o365_refresh_token IS NOT NULL LIMIT 1`, [mailbox]);
  // BF_SERVER_AUTO_REPLY_REFERRALS_v1 - a shared mailbox (info@, sales@...) is read through a connected Admin, the way
  // the CRM email flows already do; before, a shared reply-to mailbox always came back "not connected".
  const reader = u.rows[0] ?? (await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM users WHERE o365_refresh_token IS NOT NULL AND upper(coalesce(role, '')) = 'ADMIN' ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
  )).rows[0];
  if (!reader) return res.json({ ok: true, connected: false, replies: [] });
  const { getGraphForUser } = await import("../modules/o365/graphClient.js");
  const graph = await getGraphForUser(pool as any, reader.id);
  if (!graph) return res.json({ ok: true, connected: false, replies: [] });
  const base = u.rows[0] ? "/me" : `/users/${encodeURIComponent(mailbox)}`;
  const select = encodeURIComponent("from,receivedDateTime,subject,body");
  const filter = encodeURIComponent(`receivedDateTime gt ${since.toISOString()}`);
  const orderby = encodeURIComponent("receivedDateTime asc");
  // BF_SERVER_REPLIES_ALL_FOLDERS_v1 - every folder, so a reply someone already filed or deleted still counts (sent mail is
  // dropped below: it is from the mailbox itself).
  const resp = await graph.fetch(`${base}/messages?$select=${select}&$filter=${filter}&$orderby=${orderby}&$top=500`,
    { headers: { Prefer: 'outlook.body-content-type="text"' } });
  if (!resp.ok) return res.status(502).json({ ok: false, error: `graph_${resp.status}` });
  const data = (await resp.json()) as { value?: Array<{ from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; subject?: string; body?: { content?: string } }> };
  const { parseAutoReply } = await import("../services/email/autoReplyReferrals.js");
  // Still never the message itself: the sender, the time, and for an auto-reply only whether they have left and which
  // colleagues at the same company it names.
  const replies = (data.value ?? [])
    .map((m) => {
      const from = String(m.from?.emailAddress?.address ?? "").trim().toLowerCase();
      const info = parseAutoReply(String(m.subject ?? ""), String(m.body?.content ?? ""), from);
      return { from, at: m.receivedDateTime ?? null, ...(info.autoReply ? { auto_reply: true, left: info.left, referrals: info.referrals } : {}) };
    })
    .filter((m) => m.from && m.from !== mailbox && m.at);
  return res.json({ ok: true, connected: true, replies });
}));

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
