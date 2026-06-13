// BF_SERVER_BLOCK_v214_MAYA_STAFF_PIPELINE_QUERY_v1
// Routes called by the agent (Maya service) on behalf of staff
// audience. Service-JWT-authed with the shared JWT_SECRET. Every
// call writes a row to maya_audit.
import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logError } from "../observability/logger.js";
import { runPipelineQuery } from "../services/mayaPipelineQuery.js";
import { retrieveContext } from "../modules/ai/knowledge.service.js";
import { sendSms } from "../modules/notifications/sms.service.js";

const router = Router();

function getSecret(): string {
  return process.env.JWT_SECRET || "";
}

function verifyMayaService(req: Request): { source: string } | null {
  const auth = req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const secret = getSecret();
  if (!secret) return null;
  try {
    const p = jwt.verify(m[1], secret) as { kind?: string; source?: string };
    if (p?.kind !== "service") return null;
    // Maya service mints JWTs with source='maya-service' or
    // source='agent'. Accept either so the agent repo doesn't
    // have to coordinate naming.
    if (p.source !== "maya-service" && p.source !== "agent") return null;
    return { source: String(p.source) };
  } catch {
    return null;
  }
}

async function audit(opts: {
  audience: "visitor" | "client" | "staff";
  tool: string;
  args: unknown;
  ok: boolean;
  summary: string;
  errorCode?: string;
  userId?: string | null;
  sessionId?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO maya_audit
         (id, audience, user_id, session_id, tool, args_redacted, result_summary, ok, error_code)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
      [
        randomUUID(),
        opts.audience,
        opts.userId ?? null,
        opts.sessionId ?? null,
        opts.tool,
        JSON.stringify(opts.args ?? null),
        opts.summary.slice(0, 500),
        opts.ok,
        opts.errorCode ?? null,
      ],
    );
  } catch (e: any) {
    // Never block the response on audit failure.
    logError("maya_audit_insert_failed", {
      code: "maya_audit_insert_failed",
      tool: opts.tool,
      error: e?.message ?? "unknown",
    });
  }
}

router.post(
  "/staff/pipeline-query",
  safeHandler(async (req: Request, res: Response) => {
    const svc = verifyMayaService(req);
    if (!svc) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const question = typeof req.body?.question === "string" ? req.body.question : "";
    if (!question.trim()) {
      return res.status(400).json({ ok: false, error: "question_required" });
    }
    try {
      const result = await runPipelineQuery(question);
      await audit({
        audience: "staff",
        tool: "pipeline.query",
        args: { question },
        ok: !!result.ok,
        summary: result.summary ?? "",
        userId: typeof req.body?.user_id === "string" ? req.body.user_id : null,
        sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null,
      });
      return res.json(result);
    } catch (e: any) {
      await audit({
        audience: "staff",
        tool: "pipeline.query",
        args: { question },
        ok: false,
        summary: e?.message ?? "error",
        errorCode: "pipeline_query_exception",
      });
      logError("maya_pipeline_query_failed", {
        code: "maya_pipeline_query_failed",
        error: e?.message ?? "unknown",
      });
      return res.status(500).json({ ok: false, error: "pipeline_query_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_CONTACT_FIND — staff contact lookup by name/email/phone/company.
router.post(
  "/staff/contact-find",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) {
      return res.status(400).json({ ok: false, error: "query_required" });
    }
    const silo = typeof req.body?.silo === "string" ? req.body.silo.trim() : "";
    try {
      const params: unknown[] = [`%${query}%`];
      let where =
        "(c.name ILIKE $1 OR coalesce(c.email,'') ILIKE $1 OR coalesce(c.phone,'') ILIKE $1 OR coalesce(c.company_name,'') ILIKE $1)";
      if (silo) {
        params.push(silo);
        where += ` AND c.silo = $${params.length}`;
      }
      const { rows } = await pool.query(
        `SELECT c.id::text AS id, c.name, c.email, c.phone,
                coalesce(c.company_name, '') AS company,
                coalesce(c.lead_status, 'New') AS lead_status,
                c.silo
           FROM contacts c
          WHERE ${where}
          ORDER BY c.updated_at DESC NULLS LAST
          LIMIT 10`,
        params,
      );
      await audit({ audience: "staff", tool: "contact.find", args: { query, silo }, ok: true, summary: `${rows.length} matches`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, count: rows.length, contacts: rows });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "contact.find", args: { query, silo }, ok: false, summary: e?.message ?? "error", errorCode: "contact_find_exception" });
      logError("maya_contact_find_failed", { code: "maya_contact_find_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "contact_find_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_APPLICATION_SUMMARY — one-shot deal summary for staff copilot.
router.post(
  "/staff/application-summary",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const appId = typeof req.body?.application_id === "string" ? req.body.application_id.trim() : "";
    if (!appId) {
      return res.status(400).json({ ok: false, error: "application_id_required" });
    }
    try {
      const ar = await pool.query(
        `SELECT id::text AS id, name, pipeline_state, status, requested_amount, product_type, updated_at
           FROM applications WHERE id::text = $1 LIMIT 1`,
        [appId],
      );
      const app = ar.rows[0];
      if (!app) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      const cr = await pool.query(
        `SELECT c.name, c.email, c.phone, coalesce(c.company_name, '') AS company
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = $1 AND ac.role = 'applicant'
          LIMIT 1`,
        [appId],
      );
      const applicant = cr.rows[0] ?? null;
      const dr = await pool.query(
        `SELECT status, document_category FROM application_required_documents WHERE application_id::text = $1`,
        [appId],
      );
      const docsTotal = dr.rows.length;
      const missing = dr.rows
        .filter((r: any) => String(r.status) !== "accepted")
        .map((r: any) => r.document_category)
        .filter(Boolean);
      const accepted = docsTotal - missing.length;
      const stage = app.pipeline_state ?? app.status ?? "unknown";
      const nextAction =
        missing.length > 0
          ? `Collect ${missing.length} outstanding document(s): ${missing.join(", ")}`
          : "Documents complete — ready for lender match / submission review.";
      const summary = {
        applicationId: app.id,
        name: app.name,
        stage,
        status: app.status,
        requestedAmount: app.requested_amount,
        productType: app.product_type,
        applicant,
        docs: { total: docsTotal, accepted, missing },
        lastActivityAt: app.updated_at,
        nextAction,
      };
      await audit({ audience: "staff", tool: "application.summary", args: { application_id: appId }, ok: true, summary: `stage=${stage} missing=${missing.length}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "application.summary", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "application_summary_exception" });
      logError("maya_application_summary_failed", { code: "maya_application_summary_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "application_summary_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_DRAFT_EMAIL — record a staff email draft (suggest-then-approve; never sends).
router.post(
  "/staff/draft-email",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    let to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    const contactId = typeof req.body?.contact_id === "string" ? req.body.contact_id.trim() : "";
    if (!subject || !body) {
      return res.status(400).json({ ok: false, error: "subject_and_body_required" });
    }
    try {
      if (!to && contactId) {
        const cr = await pool.query(`SELECT email FROM contacts WHERE id::text = $1 LIMIT 1`, [contactId]);
        to = cr.rows[0]?.email ?? "";
      }
      await audit({ audience: "staff", tool: "comm.draft_email", args: { to, subject, contact_id: contactId }, ok: true, summary: `draft to ${to || "(unspecified)"}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, draft: { to, subject, body }, status: "draft_pending_approval", note: "Draft only — not sent. Staff must review and send." });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "comm.draft_email", args: { to, subject, contact_id: contactId }, ok: false, summary: e?.message ?? "error", errorCode: "draft_email_exception" });
      logError("maya_draft_email_failed", { code: "maya_draft_email_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "draft_email_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_APPLICATION_NEWEST — resolve the newest deal (for "open newest application").
router.post(
  "/staff/application-newest",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    try {
      const { rows } = await pool.query(
        `SELECT id::text AS id, name, pipeline_state, status, requested_amount, product_type, created_at, updated_at
           FROM applications
          WHERE parent_application_id IS NULL
          ORDER BY created_at DESC NULLS LAST
          LIMIT 1`,
      );
      const app = rows[0] ?? null;
      await audit({ audience: "staff", tool: "application.open_newest", args: {}, ok: true, summary: app ? `app=${app.id}` : "none", userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, application: app });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "application.open_newest", args: {}, ok: false, summary: e?.message ?? "error", errorCode: "application_newest_exception" });
      logError("maya_application_newest_failed", { code: "maya_application_newest_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "application_newest_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_AUDIT_RECENT — read recent Maya staff audit entries.
router.post(
  "/staff/audit-recent",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 50);
    const tool = typeof req.body?.tool === "string" ? req.body.tool.trim() : "";
    try {
      const params: unknown[] = [];
      let where = "audience = 'staff'";
      if (tool) {
        params.push(tool);
        where += ` AND tool = $${params.length}`;
      }
      params.push(limit);
      const { rows } = await pool.query(
        `SELECT tool, audience, result_summary, ok, error_code, ts
           FROM maya_audit
          WHERE ${where}
          ORDER BY ts DESC
          LIMIT $${params.length}`,
        params,
      );
      return res.json({ ok: true, count: rows.length, entries: rows });
    } catch (e: any) {
      logError("maya_audit_recent_failed", { code: "maya_audit_recent_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "audit_recent_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_SEND_SMS — 2-step: returns a draft unless approved===true, then sends via Twilio.
router.post(
  "/staff/send-sms",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
    let to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    const contactId = typeof req.body?.contact_id === "string" ? req.body.contact_id.trim() : "";
    const approved = req.body?.approved === true;
    if (!body) return res.status(400).json({ ok: false, error: "body_required" });
    try {
      if (!to && contactId) {
        const cr = await pool.query(`SELECT phone FROM contacts WHERE id::text = $1 LIMIT 1`, [contactId]);
        to = cr.rows[0]?.phone ?? "";
      }
      if (!to) return res.status(400).json({ ok: false, error: "recipient_required" });
      if (!approved) {
        await audit({ audience: "staff", tool: "comm.send_sms", args: { to, contact_id: contactId, approved: false }, ok: true, summary: `draft sms to ${to}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
        return res.json({ ok: true, draft: true, to, body, status: "draft_pending_approval", note: "Draft only — re-call with approved=true to send after staff confirms." });
      }
      const r: any = await sendSms({ to, message: body });
      const sid = r?.sid ?? null;
      await audit({ audience: "staff", tool: "comm.send_sms", args: { to, contact_id: contactId, approved: true }, ok: true, summary: `sent sms to ${to}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, sent: true, to, sid });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "comm.send_sms", args: { to, contact_id: contactId, approved }, ok: false, summary: e?.message ?? "error", errorCode: "send_sms_exception" });
      logError("maya_send_sms_failed", { code: "maya_send_sms_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "send_sms_failed" });
    }
  }),
);

// BF_SERVER_MAYA_STAFF_CALL_INITIATE — resolve number + audit; returns a dial directive (live calling wired later).
router.post(
  "/staff/call-initiate",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    let to = typeof req.body?.to === "string" ? req.body.to.trim() : "";
    const contactId = typeof req.body?.contact_id === "string" ? req.body.contact_id.trim() : "";
    try {
      if (!to && contactId) {
        const cr = await pool.query(`SELECT phone FROM contacts WHERE id::text = $1 LIMIT 1`, [contactId]);
        to = cr.rows[0]?.phone ?? "";
      }
      if (!to) return res.status(400).json({ ok: false, error: "recipient_required" });
      await audit({ audience: "staff", tool: "call.initiate", args: { to, contact_id: contactId }, ok: true, summary: `dial directive ${to}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, to, contact_id: contactId || null });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "call.initiate", args: { to, contact_id: contactId }, ok: false, summary: e?.message ?? "error", errorCode: "call_initiate_exception" });
      logError("maya_call_initiate_failed", { code: "maya_call_initiate_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "call_initiate_failed" });
    }
  }),
);


// BF_SERVER_MAYA_KNOWLEDGE_SEARCH — agent retrieval over the trained knowledge base (all audiences).
router.post(
  "/knowledge-search",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const query = typeof req.body?.query === "string" ? req.body.query.trim() : "";
    if (!query) return res.json({ ok: true, context: "" });
    try {
      const context = await retrieveContext(pool, query);
      return res.json({ ok: true, context });
    } catch (e: any) {
      logError("maya_knowledge_search_failed", { code: "maya_knowledge_search_failed", error: e?.message ?? "unknown" });
      return res.json({ ok: true, context: "" });
    }
  }),
);

// BF_SERVER_MAYA_PERSONA — agent reads tuned persona/greeting/tone (maya.* rules).
router.post(
  "/maya-persona",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    try {
      const { rows } = await pool.query<{ rule_key: string; rule_value: string }>(
        `SELECT rule_key, rule_value FROM ai_system_rules WHERE rule_key IN ('maya.persona','maya.greeting','maya.tone')`,
      );
      const cfg: Record<string, string> = {};
      for (const r of rows) cfg[r.rule_key] = r.rule_value;
      return res.json({ ok: true, persona: cfg["maya.persona"] ?? "", greeting: cfg["maya.greeting"] ?? "", tone: cfg["maya.tone"] ?? "" });
    } catch {
      return res.json({ ok: true, persona: "", greeting: "", tone: "" });
    }
  }),
);

export default router;
