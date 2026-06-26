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

// BF_SERVER_MAYA_UNDERWRITING_SUMMARY — read-only underwriting view (docs + lender-match state + blockers + draft request).
router.post(
  "/staff/underwriting-summary",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const appId = typeof req.body?.application_id === "string" ? req.body.application_id.trim() : "";
    if (!appId) return res.status(400).json({ ok: false, error: "application_id_required" });
    try {
      const ar = await pool.query(
        `SELECT id::text AS id, name, pipeline_state, status, requested_amount, product_type, updated_at,
                lender_matches, lender_matches_computed_at, lender_matches_stale, lender_matches_missing_inputs
           FROM applications WHERE id::text = $1 LIMIT 1`,
        [appId],
      );
      const app = ar.rows[0];
      if (!app) return res.status(404).json({ ok: false, error: "not_found" });

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
        `SELECT status, document_category, is_required FROM application_required_documents WHERE application_id::text = $1`,
        [appId],
      );
      const required = dr.rows.filter((r: any) => r.is_required !== false);
      const missing = required
        .filter((r: any) => String(r.status) !== "accepted")
        .map((r: any) => r.document_category)
        .filter(Boolean);
      const acceptedCount = required.length - missing.length;
      const docsComplete = required.length > 0 && missing.length === 0;

      const rawMatches = app.lender_matches;
      const matches = Array.isArray(rawMatches)
        ? rawMatches
        : Array.isArray(rawMatches?.matches)
          ? rawMatches.matches
          : [];
      const matchCount = matches.length;
      const matchesStale = app.lender_matches_stale === true;
      const missingInputs = Array.isArray(app.lender_matches_missing_inputs) ? app.lender_matches_missing_inputs : [];

      const blockers: string[] = [];
      if (missing.length > 0) blockers.push(`${missing.length} required document(s) outstanding: ${missing.join(", ")}`);
      if (!app.lender_matches_computed_at) blockers.push("Lender matches not yet computed (they run when the last required document is accepted).");
      else if (matchesStale) blockers.push("Lender matches are stale — recompute after the recent document/data changes.");
      if (missingInputs.length > 0) blockers.push(`Match engine is missing inputs: ${missingInputs.map(String).join(", ")}.`);
      if (matchCount === 0 && app.lender_matches_computed_at) blockers.push("No lender matches found for the current profile.");

      const strengths: string[] = [];
      if (docsComplete) strengths.push("All required documents accepted.");
      if (matchCount > 0) strengths.push(`${matchCount} lender match(es) available.`);
      if (app.requested_amount) strengths.push(`Requested amount on file: ${app.requested_amount}.`);

      const firstName = applicant?.name ? String(applicant.name).split(" ")[0] : "";
      const draftRequest =
        missing.length > 0
          ? `Hi${firstName ? " " + firstName : ""}, to move your application forward we still need the following: ${missing.join(", ")}. You can upload them through your secure portal link. Thank you!`
          : "";

      const stage = app.pipeline_state ?? app.status ?? "unknown";
      const summary = {
        applicationId: app.id,
        name: app.name,
        stage,
        status: app.status,
        requestedAmount: app.requested_amount,
        productType: app.product_type,
        applicant,
        docs: { requiredTotal: required.length, accepted: acceptedCount, missing },
        lenderMatches: { count: matchCount, computedAt: app.lender_matches_computed_at, stale: matchesStale, missingInputs },
        strengths,
        blockers,
        draftRequest,
        readOnly: true,
        lastActivityAt: app.updated_at,
      };

      await audit({ audience: "staff", tool: "application.underwriting_summary", args: { application_id: appId }, ok: true, summary: `missing=${missing.length} matches=${matchCount}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "application.underwriting_summary", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "underwriting_summary_exception" });
      logError("maya_underwriting_summary_failed", { code: "maya_underwriting_summary_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "underwriting_summary_failed" });
    }
  }),
);

// BF_SERVER_MAYA_LENDER_MATCH_EXPLAIN — read-only: which lenders matched a deal and why.
router.post(
  "/staff/lender-match-explain",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const appId = typeof req.body?.application_id === "string" ? req.body.application_id.trim() : "";
    if (!appId) return res.status(400).json({ ok: false, error: "application_id_required" });
    try {
      const ar = await pool.query(
        `SELECT id::text AS id, name, requested_amount, product_type,
                lender_matches, lender_matches_inputs, lender_matches_missing_inputs,
                lender_matches_computed_at, lender_matches_stale
           FROM applications WHERE id::text = $1 LIMIT 1`,
        [appId],
      );
      const app = ar.rows[0];
      if (!app) return res.status(404).json({ ok: false, error: "not_found" });

      const raw = app.lender_matches;
      const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.matches) ? raw.matches : [];
      const matches = arr.slice(0, 10).map((m: any) => ({
        lender: m?.lenderName ?? m?.lender_name ?? null,
        product: m?.productName ?? m?.product_name ?? null,
        category: m?.productCategory ?? m?.product_category ?? null,
        matchPercent: m?.matchPercent ?? m?.match_percent ?? null,
        reasoning: m?.reasoning ?? null,
      }));
      const inputs = app.lender_matches_inputs && typeof app.lender_matches_inputs === "object" ? app.lender_matches_inputs : null;
      const missingInputs = Array.isArray(app.lender_matches_missing_inputs) ? app.lender_matches_missing_inputs : [];
      const computedAt = app.lender_matches_computed_at;
      const stale = app.lender_matches_stale === true;

      const notes: string[] = [];
      if (!computedAt) notes.push("Matches not computed yet (they run when the last required document is accepted).");
      else if (stale) notes.push("Matches are stale — recompute to reflect recent changes.");
      if (missingInputs.length > 0) notes.push(`Match engine was missing: ${missingInputs.map(String).join(", ")}.`);
      if (computedAt && arr.length === 0 && missingInputs.length === 0) notes.push("No lenders matched the current amount / product / profile.");

      const result = {
        applicationId: app.id,
        name: app.name,
        requestedAmount: app.requested_amount,
        productType: app.product_type,
        inputsUsed: inputs,
        missingInputs,
        computedAt,
        stale,
        matchCount: arr.length,
        matches,
        notes,
        readOnly: true,
      };

      await audit({ audience: "staff", tool: "lender.match_explain", args: { application_id: appId }, ok: true, summary: `matches=${arr.length} stale=${stale}`, userId: typeof req.body?.user_id === "string" ? req.body.user_id : null, sessionId: typeof req.body?.session_id === "string" ? req.body.session_id : null });
      return res.json({ ok: true, result });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "lender.match_explain", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "lender_match_explain_exception" });
      logError("maya_lender_match_explain_failed", { code: "maya_lender_match_explain_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "lender_match_explain_failed" });
    }
  }),
);

// BF_SERVER_MAYA_F_PGI_READINESS_v1
// Read-only proxy: forwards a PGI document-status + carrier-readiness
// request to BI-Server (the Insurance-silo data owner) and audits to
// maya_audit. The agent only ever talks to BF-Server, so this keeps the
// single-server contract while the real read happens in BI-Server's
// /api/v1/bi/maya/staff/pgi-readiness endpoint. Accepts a BF application_id
// (resolved to its linked bi_public_id) or a bi_public_id directly.
const BI_SERVER_URL =
  process.env.BI_SERVER_URL ||
  "https://bi-server-cse0apamgkheb9d5.canadacentral-01.azurewebsites.net";

// NOTE: BI-Server's Maya routes accept source 'maya-service' | 'agent'
// only (NOT 'bf-server', which is reserved for the from-bf ingest routes).
function mintBiMayaServiceJwt(): string {
  return jwt.sign({ kind: "service", source: "maya-service" }, getSecret(), { expiresIn: "5m" });
}

router.post(
  "/staff/pgi-readiness",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) {
      return res.status(401).json({ ok: false, error: "service_jwt_required" });
    }
    const rawBiPublicId = typeof req.body?.bi_public_id === "string" ? req.body.bi_public_id.trim() : "";
    const appId = typeof req.body?.application_id === "string" ? req.body.application_id.trim() : "";
    if (!rawBiPublicId && !appId) {
      await audit({ audience: "staff", tool: "pgi.readiness", args: {}, ok: false, summary: "identifier required", errorCode: "validation_error" });
      return res.status(400).json({ ok: false, error: "application_id_or_bi_public_id_required" });
    }
    const userId = typeof req.body?.user_id === "string" ? req.body.user_id : null;
    const sessionId = typeof req.body?.session_id === "string" ? req.body.session_id : null;
    try {
      // Resolve the BI public_id. Priority: explicit bi_public_id → the
      // bi_public_id linked to a BF application → fall through to treating
      // application_id as a BI identifier (staff working the BI silo direct).
      let biPublicId = rawBiPublicId;
      let bfApplicationId: string | null = null;
      let bfAppExists = false;
      if (!biPublicId && appId) {
        const r = await pool.query<{ bi_public_id: string | null }>(
          `SELECT bi_public_id FROM applications WHERE id::text = $1 LIMIT 1`,
          [appId],
        );
        if (r.rows[0]) {
          bfAppExists = true;
          bfApplicationId = appId;
          biPublicId = r.rows[0].bi_public_id ?? "";
        }
      }

      // A known BF application that never opted into PGI has no BI row to read.
      if (bfAppExists && !biPublicId) {
        await audit({ audience: "staff", tool: "pgi.readiness", args: { application_id: appId }, ok: true, summary: "no_bi_link", userId, sessionId });
        return res.json({
          ok: true,
          result: {
            applicationId: appId,
            biLinked: false,
            readOnly: true,
            blockers: ["This application has no linked PGI / Boreal Insurance submission."],
          },
        });
      }

      const identForBi = biPublicId || appId;
      const url = `${BI_SERVER_URL.replace(/\/+$/, "")}/api/v1/bi/maya/staff/pgi-readiness`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let upstream: any = null;
      let upstreamStatus = 0;
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${mintBiMayaServiceJwt()}` },
          body: JSON.stringify({ public_id: identForBi }),
          signal: controller.signal,
        });
        upstreamStatus = resp.status;
        upstream = await resp.json().catch(() => null);
      } finally {
        clearTimeout(timeout);
      }

      if (upstreamStatus < 200 || upstreamStatus >= 300 || !upstream?.ok) {
        const code = upstream?.error ?? `bi_status_${upstreamStatus || "network"}`;
        await audit({ audience: "staff", tool: "pgi.readiness", args: { ident: identForBi }, ok: false, summary: String(code), errorCode: "bi_upstream_error", userId, sessionId });
        return res.status(upstreamStatus === 404 ? 404 : 502).json({ ok: false, error: code });
      }

      const result = { ...upstream.result, biLinked: true, bfApplicationId };
      const missingCount = Array.isArray(result?.missing) ? result.missing.length : 0;
      await audit({ audience: "staff", tool: "pgi.readiness", args: { ident: identForBi }, ok: true, summary: `missing=${missingCount} ready=${result?.carrier?.readyForCarrier}`, userId, sessionId });
      return res.json({ ok: true, result });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "pgi.readiness", args: {}, ok: false, summary: e?.message ?? "error", errorCode: "pgi_readiness_exception", userId, sessionId });
      logError("maya_pgi_readiness_failed", { code: "maya_pgi_readiness_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "pgi_readiness_failed" });
    }
  }),
);

// BF_SERVER_MAYA_BATCH_B_STAFF_READS_v1 — four read-only staff endpoints
// (lender-product lookup, contact-360 timeline, call/voicemail triage, deal
// risk flags). Service-JWT gated like the rest of mayaStaff; audits to
// maya_audit. BF-silo data only.
function biStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function biNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// 35. lender.products — search active lender products by category/country/amount.
router.post(
  "/staff/lender-products",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const category = biStr(req.body?.category);
    const country = biStr(req.body?.country);
    const amount = biNum(req.body?.amount);
    try {
      const r = await pool.query(
        `SELECT lp.id::text AS id, lp.name, lp.category, lp.country, lp.region,
                lp.amount_min, lp.amount_max, lp.interest_min, lp.interest_max, l.name AS lender_name
           FROM lender_products lp
           JOIN lenders l ON l.id = lp.lender_id
          WHERE lp.active = true
            AND ($1::text IS NULL OR upper(lp.category) = upper($1))
            AND ($2::text IS NULL OR lp.country = $2)
            AND ($3::numeric IS NULL OR (
                  (lp.amount_min IS NULL OR lp.amount_min <= $3)
              AND (lp.amount_max IS NULL OR lp.amount_max >= $3)))
          ORDER BY l.name, lp.name
          LIMIT 50`,
        [category, country, amount],
      );
      const products = r.rows.map((p: any) => ({
        id: p.id,
        lender: p.lender_name,
        product: p.name,
        category: p.category ?? null,
        country: p.country ?? null,
        region: p.region ?? null,
        amountMin: p.amount_min ?? null,
        amountMax: p.amount_max ?? null,
        interestMin: p.interest_min ?? null,
        interestMax: p.interest_max ?? null,
      }));
      const summary = products.length ? `${products.length} matching lender product(s).` : "No active lender products match those filters.";
      await audit({ audience: "staff", tool: "lender.products", args: { category, country, amount }, ok: true, summary, userId: biStr(req.body?.user_id), sessionId: biStr(req.body?.session_id) });
      return res.json({ ok: true, products, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "lender.products", args: { category, country, amount }, ok: false, summary: e?.message ?? "error", errorCode: "lender_products_exception" });
      logError("maya_lender_products_failed", { code: "maya_lender_products_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "lender_products_failed" });
    }
  }),
);

// 37. contact.timeline — UNION of call_events + communications_messages for a contact.
router.post(
  "/staff/contact-timeline",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const contactId = biStr(req.body?.contact_id);
    const silo = biStr(req.body?.silo);
    const limit = Math.min(biNum(req.body?.limit) ?? 25, 100);
    if (!contactId) return res.status(400).json({ ok: false, error: "contact_id_required" });
    try {
      const r = await pool.query(
        `SELECT kind, subtype, direction, created_at, from_number, to_number, body FROM (
            SELECT 'call' AS kind, event_type AS subtype, direction, created_at,
                   from_number, to_number, NULL::text AS body
              FROM call_events
             WHERE contact_id::text = $1 AND ($2::text IS NULL OR silo = $2)
            UNION ALL
            SELECT 'message' AS kind, type AS subtype, direction, created_at,
                   NULL::text AS from_number, NULL::text AS to_number, body
              FROM communications_messages
             WHERE contact_id::text = $1
         ) t
         ORDER BY created_at DESC
         LIMIT $3`,
        [contactId, silo, limit],
      );
      const events = r.rows.map((e: any) => ({ kind: e.kind, type: e.subtype ?? null, direction: e.direction ?? null, at: e.created_at, from: e.from_number ?? null, to: e.to_number ?? null, body: e.body ?? null }));
      const summary = events.length ? `${events.length} recent activity item(s).` : "No recent calls or messages for this contact.";
      await audit({ audience: "staff", tool: "contact.timeline", args: { contact_id: contactId, silo }, ok: true, summary, userId: biStr(req.body?.user_id), sessionId: biStr(req.body?.session_id) });
      return res.json({ ok: true, events, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "contact.timeline", args: { contact_id: contactId, silo }, ok: false, summary: e?.message ?? "error", errorCode: "contact_timeline_exception" });
      logError("maya_contact_timeline_failed", { code: "maya_contact_timeline_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "contact_timeline_failed" });
    }
  }),
);

// 42. call.triage — recent voicemails + missed calls needing follow-up.
router.post(
  "/staff/call-triage",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const silo = biStr(req.body?.silo);
    const limit = Math.min(biNum(req.body?.limit) ?? 15, 50);
    try {
      const vm = await pool.query(`SELECT id::text AS id, call_sid, recording_url, created_at FROM voicemails ORDER BY created_at DESC LIMIT $1`, [limit]);
      const missed = await pool.query(
        `SELECT id::text AS id, contact_id::text AS contact_id, from_number, to_number, created_at
           FROM call_events
          WHERE event_type = 'call.missed' AND ($1::text IS NULL OR silo = $1)
          ORDER BY created_at DESC LIMIT $2`,
        [silo, limit],
      );
      const voicemails = vm.rows.map((v: any) => ({ id: v.id, callSid: v.call_sid, recordingUrl: v.recording_url, at: v.created_at }));
      const missedCalls = missed.rows.map((m: any) => ({ id: m.id, contactId: m.contact_id, from: m.from_number, to: m.to_number, at: m.created_at }));
      const summary = `${voicemails.length} voicemail(s) and ${missedCalls.length} missed call(s) awaiting follow-up.`;
      await audit({ audience: "staff", tool: "call.triage", args: { silo }, ok: true, summary, userId: biStr(req.body?.user_id), sessionId: biStr(req.body?.session_id) });
      return res.json({ ok: true, voicemails, missedCalls, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "call.triage", args: { silo }, ok: false, summary: e?.message ?? "error", errorCode: "call_triage_exception" });
      logError("maya_call_triage_failed", { code: "maya_call_triage_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "call_triage_failed" });
    }
  }),
);

// 45. application.risk_flags — lightweight read-only risk flags for a deal.
router.post(
  "/staff/risk-flags",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const appId = biStr(req.body?.application_id);
    if (!appId) return res.status(400).json({ ok: false, error: "application_id_required" });
    try {
      const ar = await pool.query(`SELECT id::text AS id, name, pipeline_state, status, requested_amount, product_type, updated_at FROM applications WHERE id::text = $1 LIMIT 1`, [appId]);
      const app = ar.rows[0];
      if (!app) return res.status(404).json({ ok: false, error: "not_found" });
      const dr = await pool.query(`SELECT status, document_category FROM application_required_documents WHERE application_id::text = $1`, [appId]);
      const missing = dr.rows.filter((r: any) => String(r.status) !== "accepted").map((r: any) => r.document_category).filter(Boolean);
      const flags: string[] = [];
      const amount = biNum(app.requested_amount);
      if (missing.length) flags.push(`${missing.length} document(s) outstanding: ${missing.join(", ")}`);
      if (amount != null && amount >= 1000000) flags.push("Large request (≥ $1M) — extra scrutiny.");
      const updated = app.updated_at ? new Date(app.updated_at).getTime() : null;
      const stale = updated != null && Date.now() - updated > 14 * 864e5 && !/funded|declined|closed/i.test(String(app.pipeline_state ?? app.status ?? ""));
      if (stale) flags.push("No activity in 14+ days — at risk of going cold.");
      const summary = flags.length ? `${flags.length} risk flag(s): ${flags.join("; ")}` : "No notable risk flags on this deal.";
      await audit({ audience: "staff", tool: "application.risk_flags", args: { application_id: appId }, ok: true, summary, userId: biStr(req.body?.user_id), sessionId: biStr(req.body?.session_id) });
      return res.json({ ok: true, applicationId: app.id, stage: app.pipeline_state ?? app.status ?? null, flags, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "application.risk_flags", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "risk_flags_exception" });
      logError("maya_risk_flags_failed", { code: "maya_risk_flags_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "risk_flags_failed" });
    }
  }),
);

// BF_SERVER_MAYA_BATCH_B2_STAFF_READS_v1 — five read-only staff endpoints
// (banking summary, credit-summary readout, contact notes, missing-doc request
// draft, daily briefing). Service-JWT gated; audits to maya_audit. BF silo.
function b2Str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function b2Num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// 28. banking.summary — latest banking-analysis metrics for a deal.
router.post(
  "/staff/banking-summary",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const appId = b2Str(req.body?.application_id);
    if (!appId) return res.status(400).json({ ok: false, error: "application_id_required" });
    try {
      const appRow = await pool.query(
        `SELECT banking_completed_at,
                COALESCE((metadata->>'banking_auto_skip')::boolean, false) AS banking_auto_skip
           FROM applications WHERE id::text = $1 LIMIT 1`,
        [appId],
      );
      if (appRow.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });
      if (appRow.rows[0].banking_auto_skip) {
        await audit({ audience: "staff", tool: "banking.summary", args: { application_id: appId }, ok: true, summary: "auto_skip" });
        return res.json({ ok: true, applicationId: appId, available: false, summary: "Banking analysis was skipped — no bank statements were found on this application." });
      }
      const r = await pool.query(
        `SELECT total_avg_monthly_deposits, average_daily_balance, total_deposits,
                total_withdrawals, average_monthly_nsfs, months_profitable_numerator,
                months_profitable_denominator, period_start, period_end, months_detected, status, updated_at
           FROM banking_analyses
          WHERE application_id::text = $1
          ORDER BY updated_at DESC LIMIT 1`,
        [appId],
      );
      if (r.rowCount === 0) {
        await audit({ audience: "staff", tool: "banking.summary", args: { application_id: appId }, ok: true, summary: "waiting" });
        return res.json({ ok: true, applicationId: appId, available: false, summary: "No banking analysis yet — still waiting on or processing bank statements." });
      }
      const b = r.rows[0];
      const metrics = {
        avgMonthlyDeposits: b.total_avg_monthly_deposits ?? null,
        averageDailyBalance: b.average_daily_balance ?? null,
        totalDeposits: b.total_deposits ?? null,
        totalWithdrawals: b.total_withdrawals ?? null,
        avgMonthlyNSFs: b.average_monthly_nsfs ?? null,
        monthsProfitable: b.months_profitable_numerator != null && b.months_profitable_denominator != null ? `${b.months_profitable_numerator}/${b.months_profitable_denominator}` : null,
        periodStart: b.period_start ?? null,
        periodEnd: b.period_end ?? null,
        monthsDetected: b.months_detected ?? null,
        status: b.status ?? null,
      };
      const summary = `Banking: avg monthly deposits ${metrics.avgMonthlyDeposits ?? "n/a"}, avg daily balance ${metrics.averageDailyBalance ?? "n/a"}, avg monthly NSFs ${metrics.avgMonthlyNSFs ?? "n/a"}${metrics.monthsProfitable ? `, profitable ${metrics.monthsProfitable} months` : ""} over ${metrics.monthsDetected ?? "?"} month(s).`;
      await audit({ audience: "staff", tool: "banking.summary", args: { application_id: appId }, ok: true, summary: `nsf=${metrics.avgMonthlyNSFs ?? "?"}` });
      return res.json({ ok: true, applicationId: appId, available: true, metrics, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "banking.summary", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "banking_summary_exception" });
      logError("maya_banking_summary_failed", { code: "maya_banking_summary_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "banking_summary_failed" });
    }
  }),
);

// 30. credit.summary — read existing credit summary (never regenerates).
router.post(
  "/staff/credit-summary",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const appId = b2Str(req.body?.application_id);
    if (!appId) return res.status(400).json({ ok: false, error: "application_id_required" });
    try {
      const r = await pool.query(
        `SELECT sections, status, version, updated_at
           FROM credit_summaries WHERE application_id::text = $1
          ORDER BY updated_at DESC LIMIT 1`,
        [appId],
      );
      if (r.rowCount === 0) {
        await audit({ audience: "staff", tool: "credit.summary", args: { application_id: appId }, ok: true, summary: "none" });
        return res.json({ ok: true, applicationId: appId, available: false, summary: "No credit summary has been generated for this deal yet." });
      }
      const row = r.rows[0];
      const sections = row.sections && typeof row.sections === "object" ? row.sections : {};
      const sectionReadout: Record<string, string> = {};
      for (const [key, val] of Object.entries(sections as Record<string, unknown>)) {
        let text = "";
        if (typeof val === "string") text = val;
        else if (val && typeof val === "object") {
          const narrative = (val as any).narrative ?? (val as any).text ?? (val as any).content;
          if (typeof narrative === "string") text = narrative;
          else text = JSON.stringify(val);
        }
        if (text.trim()) sectionReadout[key] = text.trim().slice(0, 400);
      }
      const summary = `Credit summary (status: ${row.status ?? "draft"}, v${row.version ?? 1}) with section(s): ${Object.keys(sectionReadout).join(", ") || "none populated"}.`;
      await audit({ audience: "staff", tool: "credit.summary", args: { application_id: appId }, ok: true, summary: `status=${row.status}` });
      return res.json({ ok: true, applicationId: appId, available: true, status: row.status ?? null, version: row.version ?? null, sections: sectionReadout, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "credit.summary", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "credit_summary_exception" });
      logError("maya_credit_summary_failed", { code: "maya_credit_summary_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "credit_summary_failed" });
    }
  }),
);

// 31. notes.read — recent CRM notes for a contact (and/or company).
router.post(
  "/staff/notes-read",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const contactId = b2Str(req.body?.contact_id);
    const companyId = b2Str(req.body?.company_id);
    const silo = b2Str(req.body?.silo);
    const limit = Math.min(b2Num(req.body?.limit) ?? 20, 100);
    if (!contactId && !companyId) return res.status(400).json({ ok: false, error: "contact_id_or_company_id_required" });
    try {
      const r = await pool.query(
        `SELECT id::text AS id, body, owner_id::text AS owner_id, created_at
           FROM crm_notes
          WHERE ($1::uuid IS NULL OR contact_id = $1::uuid)
            AND ($2::uuid IS NULL OR company_id = $2::uuid)
            AND ($3::text IS NULL OR silo = $3)
          ORDER BY created_at DESC LIMIT $4`,
        [contactId, companyId, silo, limit],
      );
      const notes = r.rows.map((nr: any) => ({ id: nr.id, body: typeof nr.body === "string" ? nr.body.slice(0, 600) : "", ownerId: nr.owner_id ?? null, at: nr.created_at }));
      const summary = notes.length ? `${notes.length} note(s), most recent first.` : "No notes on file for this contact.";
      await audit({ audience: "staff", tool: "notes.read", args: { contact_id: contactId, company_id: companyId, silo }, ok: true, summary });
      return res.json({ ok: true, notes, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "notes.read", args: { contact_id: contactId, company_id: companyId, silo }, ok: false, summary: e?.message ?? "error", errorCode: "notes_read_exception" });
      logError("maya_notes_read_failed", { code: "maya_notes_read_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "notes_read_failed" });
    }
  }),
);

// 32. docs.request_draft — draft (NOT send) a missing-document request message.
router.post(
  "/staff/docs-request-draft",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const appId = b2Str(req.body?.application_id);
    if (!appId) return res.status(400).json({ ok: false, error: "application_id_required" });
    try {
      const ar = await pool.query(
        `SELECT a.name AS app_name, c.name AS applicant_name
           FROM applications a
           LEFT JOIN application_contacts ac ON ac.application_id = a.id AND ac.role = 'applicant'
           LEFT JOIN contacts c ON c.id = ac.contact_id
          WHERE a.id::text = $1 LIMIT 1`,
        [appId],
      );
      if (ar.rowCount === 0) return res.status(404).json({ ok: false, error: "not_found" });
      const applicantName = b2Str(ar.rows[0].applicant_name) ?? "there";
      const dr = await pool.query(
        `SELECT document_category FROM application_required_documents
          WHERE application_id::text = $1 AND status <> 'accepted'`,
        [appId],
      );
      const missing = dr.rows.map((r: any) => r.document_category).filter(Boolean);
      if (!missing.length) {
        await audit({ audience: "staff", tool: "docs.request_draft", args: { application_id: appId }, ok: true, summary: "nothing_missing" });
        return res.json({ ok: true, applicationId: appId, missing: [], draft: null, summary: "All required documents are in — nothing to request." });
      }
      const draft = `Hi ${applicantName.split(" ")[0]}, to keep your Boreal application moving we still need: ${missing.join(", ")}. You can upload them any time in your application — reply here if you have any questions. Thanks!`;
      await audit({ audience: "staff", tool: "docs.request_draft", args: { application_id: appId }, ok: true, summary: `missing=${missing.length}` });
      return res.json({ ok: true, applicationId: appId, missing, draft, summary: `Drafted a request for ${missing.length} document(s). Review and send manually — Maya does not send it.` });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "docs.request_draft", args: { application_id: appId }, ok: false, summary: e?.message ?? "error", errorCode: "docs_request_draft_exception" });
      logError("maya_docs_request_draft_failed", { code: "maya_docs_request_draft_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "docs_request_draft_failed" });
    }
  }),
);

// 43. daily.briefing — what needs staff attention right now (silo-scoped).
router.post(
  "/staff/daily-briefing",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const silo = b2Str(req.body?.silo) ?? "BF";
    try {
      const num = async (sql: string, params: unknown[] = []): Promise<number> =>
        pool.query(sql, params).then((r) => Number((r.rows[0] as { n?: unknown })?.n ?? 0) || 0).catch(() => 0);
      const sp: unknown[] = [silo];
      const [
        newAppsToday, submittedToday, dealsAwaitingDocs, staleDeals,
        inboundSmsToday, inboundEmailsToday, chatsToday, recentNotes,
        openCrmTasks, openAppTasks, recentVoicemails, recentMissedCalls,
      ] = await Promise.all([
        num(`SELECT COUNT(*)::int AS n FROM applications WHERE ($1::text IS NULL OR silo = $1) AND created_at >= date_trunc('day', now())`, sp),
        num(`SELECT COUNT(*)::int AS n FROM applications WHERE ($1::text IS NULL OR silo = $1) AND submitted_at >= date_trunc('day', now())`, sp),
        num(`SELECT COUNT(DISTINCT a.id)::int AS n FROM applications a JOIN application_required_documents d ON d.application_id = a.id WHERE ($1::text IS NULL OR a.silo = $1) AND d.status <> 'accepted'`, sp),
        num(`SELECT COUNT(*)::int AS n FROM applications a WHERE ($1::text IS NULL OR a.silo = $1) AND a.updated_at < now() - interval '14 days' AND COALESCE(a.pipeline_state, a.status, '') !~* 'funded|declined|closed'`, sp),
        num(`SELECT COUNT(*)::int AS n FROM communications_messages WHERE ($1::text IS NULL OR silo = $1) AND lower(COALESCE(type, '')) = 'sms' AND lower(COALESCE(direction, '')) = 'inbound' AND created_at >= date_trunc('day', now())`, sp),
        num(`SELECT COUNT(*)::int AS n FROM communications_messages WHERE ($1::text IS NULL OR silo = $1) AND lower(COALESCE(type, '')) = 'email' AND lower(COALESCE(direction, '')) = 'inbound' AND created_at >= date_trunc('day', now())`, sp),
        num(`SELECT COUNT(*)::int AS n FROM communications_messages WHERE ($1::text IS NULL OR silo = $1) AND lower(COALESCE(type, '')) IN ('chat', 'message') AND lower(COALESCE(direction, '')) = 'inbound' AND created_at >= date_trunc('day', now())`, sp),
        num(`SELECT COUNT(*)::int AS n FROM crm_notes WHERE ($1::text IS NULL OR silo = $1) AND created_at >= date_trunc('day', now())`, sp),
        num(`SELECT COUNT(*)::int AS n FROM crm_tasks WHERE ($1::text IS NULL OR silo = $1) AND lower(COALESCE(status, '')) NOT IN ('done', 'completed', 'complete', 'closed', 'cancelled')`, sp),
        num(`SELECT COUNT(*)::int AS n FROM application_tasks t JOIN applications a ON a.id = t.application_id WHERE ($1::text IS NULL OR a.silo = $1) AND t.completed_at IS NULL`, sp),
        num(`SELECT COUNT(*)::int AS n FROM voicemails WHERE created_at > now() - interval '2 days'`),
        num(`SELECT COUNT(*)::int AS n FROM call_events WHERE event_type = 'call.missed' AND ($1::text IS NULL OR silo = $1) AND created_at > now() - interval '2 days'`, sp),
      ]);
      const counts = {
        newAppsToday, submittedToday, dealsAwaitingDocs, staleDeals,
        inboundSmsToday, inboundEmailsToday, chatsToday, recentNotes,
        openTasks: openCrmTasks + openAppTasks, recentVoicemails, recentMissedCalls,
      };
      const parts: string[] = [];
      if (counts.newAppsToday) parts.push(`${counts.newAppsToday} new application(s) today`);
      if (counts.submittedToday) parts.push(`${counts.submittedToday} submitted today`);
      if (counts.dealsAwaitingDocs) parts.push(`${counts.dealsAwaitingDocs} deal(s) waiting on documents`);
      if (counts.staleDeals) parts.push(`${counts.staleDeals} stale deal(s) (14+ days quiet)`);
      if (counts.inboundSmsToday) parts.push(`${counts.inboundSmsToday} inbound SMS today`);
      if (counts.inboundEmailsToday) parts.push(`${counts.inboundEmailsToday} inbound email(s) today`);
      if (counts.chatsToday) parts.push(`${counts.chatsToday} new chat message(s) today`);
      if (counts.recentNotes) parts.push(`${counts.recentNotes} note(s) added today`);
      if (counts.openTasks) parts.push(`${counts.openTasks} open task(s)`);
      if (counts.recentVoicemails) parts.push(`${counts.recentVoicemails} recent voicemail(s)`);
      if (counts.recentMissedCalls) parts.push(`${counts.recentMissedCalls} recent missed call(s)`);
      const summary = parts.length
        ? `Here is your day in ${silo}: ${parts.join("; ")}.`
        : `Nothing outstanding in ${silo} right now — you are clear.`;
      await audit({ audience: "staff", tool: "daily.briefing", args: { silo }, ok: true, summary });
      return res.json({ ok: true, silo, counts, summary });
    } catch (e: any) {
      await audit({ audience: "staff", tool: "daily.briefing", args: { silo }, ok: false, summary: e?.message ?? "error", errorCode: "daily_briefing_exception" });
      logError("maya_daily_briefing_failed", { code: "maya_daily_briefing_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "daily_briefing_failed" });
    }
  }),
);

// BF_SERVER_MAYA_CLIENT_HISTORY_v1 — resolve a signed-in client's own
// application(s) by phone so Maya "knows them" without an application_id.
function myAppStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
router.post(
  "/staff/applications-by-phone",
  safeHandler(async (req: Request, res: Response) => {
    if (!verifyMayaService(req)) return res.status(401).json({ ok: false, error: "service_jwt_required" });
    const phone = myAppStr(req.body?.phone);
    const phone10 = phone ? phone.replace(/[^0-9]/g, "").slice(-10) : "";
    if (phone10.length < 10) {
      return res.json({ ok: true, applications: [], summary: "I don't have a valid phone number on file to look you up." });
    }
    try {
      const r = await pool.query(
        `SELECT a.id::text AS id, a.name, a.pipeline_state, a.status,
                a.requested_amount, a.product_type, a.updated_at
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
          ORDER BY a.updated_at DESC
          LIMIT 10`,
        [phone10],
      );
      const applications = r.rows.map((a: any) => ({
        id: a.id, name: a.name ?? null,
        stage: a.pipeline_state ?? a.status ?? null, status: a.status ?? null,
        requestedAmount: a.requested_amount ?? null, productType: a.product_type ?? null,
        updatedAt: a.updated_at,
      }));
      let latestDocs: { total: number; missing: string[] } | null = null;
      if (applications.length) {
        const dr = await pool.query(
          `SELECT status, document_category FROM application_required_documents WHERE application_id::text = $1`,
          [applications[0].id],
        );
        const missing = dr.rows.filter((x: any) => String(x.status) !== "accepted").map((x: any) => x.document_category).filter(Boolean);
        latestDocs = { total: dr.rows.length, missing };
      }
      const summary = applications.length
        ? `Found ${applications.length} application(s). Most recent: "${applications[0].name ?? "your application"}" at stage "${applications[0].stage ?? "in progress"}".`
        : "No applications found for that phone number yet — they may be just getting started.";
      await audit({ audience: "client", tool: "application.find_mine", args: { phone10 }, ok: true, summary: `${applications.length} apps`, userId: myAppStr(req.body?.user_id), sessionId: myAppStr(req.body?.session_id) });
      return res.json({ ok: true, applications, latestDocs, summary });
    } catch (e: any) {
      await audit({ audience: "client", tool: "application.find_mine", args: { phone10 }, ok: false, summary: e?.message ?? "error", errorCode: "applications_by_phone_exception" });
      logError("maya_applications_by_phone_failed", { code: "maya_applications_by_phone_failed", error: e?.message ?? "unknown" });
      return res.status(500).json({ ok: false, error: "applications_by_phone_failed" });
    }
  }),
);

export default router;
