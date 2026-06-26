import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { createPnwSigningSession, isPnwDocType } from "../../signnow/pnwSigning.js";
import continuationRouter from "./continuation.js";
import documentsRouter from "./documents.js";
import applicationsRouter from "./applications.js";
import lendersRouter from "./lenders.js";
import lenderProductsRouter from "./lenderProducts.js";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes.js";
import sessionRouter from "./session.js";
import submitAttemptsRouter from "./submitAttempts.js";
import {
  clientDocumentsRateLimit,
  clientReadRateLimit,
  safeKeyGenerator,
} from "../../middleware/rateLimit.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";
import { AppError } from "../../middleware/errors.js";

const router = Router();
router.use(submitAttemptsRouter); // BF_SERVER_BLOCK_v842_SUBMIT_ATTEMPTS — frictionless beacon, before rate-limit/ownership middleware
const clientReadLimiter = clientReadRateLimit() as any;

router.use((req: any, res: any, next: any) => {
  if (req.method === "GET") {
    clientReadLimiter(req, res, next);
    return;
  }
  next();
});

// BF_SERVER_BLOCK_v728_SOFT_APP_OWNERSHIP_v1 — defense-in-depth for the capability
// (app-id) client endpoints. App IDs are unguessable UUIDs, so this only closes the
// "logged-in client pivots to an app that isn't theirs" vector: when a request carries
// a valid OTP session token AND targets a specific applicationId, verify the app
// belongs to that phone. No token / no app id / unverifiable token -> allowed (this
// preserves SMS deep-links and the capability model). Never breaks a request on error.
router.use(async (req: any, res: any, next: any) => {
  try {
    const aid =
      (typeof req.query?.applicationId === "string" && req.query.applicationId.trim()) ||
      (typeof req.body?.applicationId === "string" && req.body.applicationId.trim()) ||
      "";
    if (!aid) return next();
    const auth = req.headers?.authorization;
    if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) return next();
    const secret = process.env.JWT_SECRET;
    if (!secret) return next();
    let phone10 = "";
    try {
      const decoded = jwt.verify(auth.slice(7), secret) as Record<string, unknown>;
      phone10 = String(typeof decoded.phone === "string" ? decoded.phone : "")
        .replace(/[^0-9]/g, "")
        .slice(-10);
    } catch {
      return next(); // invalid/expired token -> treat as capability access, don't block
    }
    if (!phone10) return next();
    // BF_SERVER_BLOCK_v_CLIENT_OWNERSHIP_PARTNER_FIX_v1 — ownership must consider
    // ALL contacts linked to the application (applicant + partner + guarantor) via
    // application_contacts, not just applications.contact_id. On a partner app the
    // logged-in person can be the PARTNER, whose phone != the applicant contact,
    // which made mine===0 -> 403 on every CMP read. UNION the link-table members
    // with the legacy single contact_id so pre-link-table solo apps still resolve.
    // Mirrors the correct pattern in auth.ts.
    const r = await dbQuery(
      `WITH app_phones AS (
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = ($1)::text
         UNION
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = ($1)::text
       )
       SELECT
         (SELECT COUNT(*)::int FROM applications WHERE id::text = ($1)::text) AS total,
         (SELECT COUNT(*)::int FROM app_phones WHERE p10 = $2)               AS mine`,
      [aid, phone10],
    );
    const total = Number(r.rows?.[0]?.total ?? 0);
    const mine = Number(r.rows?.[0]?.mine ?? 0);
    if (total > 0 && mine === 0) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    return next();
  } catch {
    return next();
  }
});

router.use("/", continuationRouter);
router.use("/", applicationsRouter);
router.use("/lenders", lendersRouter);
router.use("/", lenderProductsRouter);
router.use("/", clientSubmissionRoutes);
router.use("/", sessionRouter);

// BF_SERVER_BLOCK_v_CLIENT_ACCOUNT_DELETE_v1 — store-required (Apple 5.1.1(v) +
// Google) account/data deletion. The CMP "Delete account" button POSTs here with
// { applicationId }. Ownership is already enforced by the client router's phone-
// match middleware (non-owners get 403 before reaching this). Hard-deletes the
// application; child rows (form responses, contacts links, messages, documents,
// packages, call events, etc.) chain via ON DELETE CASCADE
// (migration 2026_06_03_v694_application_delete_cascade.sql).
router.post("/account/delete", safeHandler(async (req: any, res: any) => {
  const applicationId =
    (typeof req.body?.applicationId === "string" && req.body.applicationId.trim()) ||
    (typeof req.query?.applicationId === "string" && req.query.applicationId.trim()) || null;
  if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) { res.status(400).json({ error: "invalid_id" }); return; }
  const { pool } = await import("../../db.js");
  const { rowCount } = await pool.query(
    `DELETE FROM applications WHERE id::text = ($1)::text`, [applicationId]);
  if (!rowCount) { res.status(404).json({ error: "not_found" }); return; }
  res.json({ ok: true, deleted: true });
}));

// BF_SERVER_BLOCK_v_CLIENT_FORM_RESPONSES_v1 — client-authenticated form-responses.
// The CMP previously used the STAFF-gated /api/portal/.../form-responses routes,
// so the client could never save CRA/flinks/advisors/etc. These mirror the portal
// routes on the SAME application_form_responses table, but authorize via the client
// router's phone-based ownership. doc_type is the long key the forms use
// (cra_view_only_authorization, flinks_banking, ...).
{
  const formResponseApplicationId = (req: any) =>
    (typeof req.query?.applicationId === "string" && req.query.applicationId.trim()) ||
    (typeof req.body?.applicationId === "string" && req.body.applicationId.trim()) ||
    (typeof req.params?.id === "string" && req.params.id.trim()) ||
    null;

  const verifyFormResponseOwnership = async (req: any, res: any, appId: string) => {
    const auth = req.headers?.authorization;
    if (!auth || typeof auth !== "string" || !auth.startsWith("Bearer ")) return true;
    const secret = process.env.JWT_SECRET;
    if (!secret) return true;
    let phone10 = "";
    try {
      const decoded = jwt.verify(auth.slice(7), secret) as Record<string, unknown>;
      phone10 = String(typeof decoded.phone === "string" ? decoded.phone : "")
        .replace(/[^0-9]/g, "")
        .slice(-10);
    } catch {
      return true;
    }
    if (!phone10) return true;
    const result = await dbQuery(
      `WITH app_phones AS (
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM application_contacts ac
           JOIN contacts c ON c.id = ac.contact_id
          WHERE ac.application_id::text = ($1)::text
         UNION
         SELECT right(regexp_replace(coalesce(c.phone,''),'[^0-9]','','g'),10) AS p10
           FROM applications a
           JOIN contacts c ON c.id = a.contact_id
          WHERE a.id::text = ($1)::text
       )
       SELECT
         (SELECT COUNT(*)::int FROM applications WHERE id::text = ($1)::text) AS total,
         (SELECT COUNT(*)::int FROM app_phones WHERE p10 = $2)               AS mine`,
      [appId, phone10],
    );
    const total = Number(result.rows?.[0]?.total ?? 0);
    const mine = Number(result.rows?.[0]?.mine ?? 0);
    if (total > 0 && mine === 0) {
      res.status(403).json({ error: "forbidden" });
      return false;
    }
    return true;
  };

  router.get(
    "/applications/:id/form-responses/:doc_type",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      const docType = String(req.params.doc_type);
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      const result = await dbQuery(
        `SELECT id, doc_type, data, submitted_at, created_at, updated_at
           FROM application_form_responses
          WHERE application_id::text = ($1)::text AND doc_type = $2
          LIMIT 1`,
        [appId, docType],
      );
      if (result.rowCount === 0) { res.status(404).json({ error: "not_found" }); return; }
      res.json({ item: result.rows[0] });
    }),
  );

  router.get(
    "/applications/:id/form-responses",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      const result = await dbQuery(
        `SELECT id, doc_type, data, submitted_at, created_at, updated_at
           FROM application_form_responses
          WHERE application_id::text = ($1)::text
          ORDER BY updated_at DESC`,
        [appId],
      );
      res.json({ items: result.rows });
    }),
  );

  router.put(
    "/applications/:id/form-responses/:doc_type",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      const docType = String(req.params.doc_type);
      const data = req.body?.data;
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        res.status(400).json({ error: "data_required" });
        return;
      }
      const result = await dbQuery(
        `INSERT INTO application_form_responses (application_id, doc_type, data, updated_at)
              VALUES ($1, $2, $3::jsonb, NOW())
              ON CONFLICT (application_id, doc_type)
              DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
           RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
        [appId, docType, JSON.stringify(data)],
      );
      res.json({ item: result.rows[0] });
    }),
  );

  router.post(
    "/applications/:id/form-responses/:doc_type/submit",
    safeHandler(async (req: any, res: any) => {
      const appId = formResponseApplicationId(req);
      const docType = String(req.params.doc_type);
      const data = req.body?.data;
      const hasData = data && typeof data === "object" && !Array.isArray(data);
      if (!appId) { res.status(400).json({ error: "applicationId_required" }); return; }
      if (!(await verifyFormResponseOwnership(req, res, appId))) return;
      const result = hasData
        ? await dbQuery(
            `INSERT INTO application_form_responses (application_id, doc_type, data, submitted_at, updated_at)
                  VALUES ($1, $2, $3::jsonb, NOW(), NOW())
                  ON CONFLICT (application_id, doc_type)
                  DO UPDATE SET data = EXCLUDED.data, submitted_at = NOW(), updated_at = NOW()
               RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
            [appId, docType, JSON.stringify(data)],
          )
        : await dbQuery(
            `UPDATE application_form_responses
                SET submitted_at = NOW(), updated_at = NOW()
              WHERE application_id::text = ($1)::text AND doc_type = $2
              RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
            [appId, docType],
          );
      if (result.rowCount === 0) { res.status(404).json({ error: "not_found" }); return; }
      // BF_SERVER_BLOCK_v_PNW_SIGNING_v1 — sign the Personal Net Worth statement
      // individually, the instant it is submitted (its own one-signer envelope).
      let signing_url: string | null = null;
      if (isPnwDocType(docType)) {
        try { signing_url = (await createPnwSigningSession(appId)).url; }
        catch (e) { console.warn("[pnw_signing] session create failed", e instanceof Error ? e.message : String(e)); }
      }
      res.json({ item: result.rows[0], ...(signing_url ? { signing_url } : {}) });
    }),
  );
}
// BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_v1 — the CMP legitimately polls ~38 req/min
// (loadAll fans 6 GETs/15s + typing/10s + signing-complete/8s). The shared
// globalLimiter (200/15min) starved /signing-session, hiding the Sign button.
// Give authenticated client polling a realistic ceiling.
// BF_SERVER_BLOCK_v_SIGN_ALLSIGNERS_HOTFIX1 — use safeKeyGenerator (wraps
// express-rate-limit's ipKeyGenerator) instead of rateLimitKeyFromRequest,
// which threw ERR_ERL_KEY_GEN_IPV6 at construction and crashed boot.
const cmpPollLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "RATE_LIMITED" },
  keyGenerator: safeKeyGenerator,
  validate: { xForwardedForHeader: false, trustProxy: false },
});
router.use(cmpPollLimiter);

router.use("/documents", clientDocumentsRateLimit(), documentsRouter);

// BF_SERVER_BLOCK_v696_CLIENT_STAGE_v1 — client-accessible application stage.
// The staff /api/applications/:id surface requires APPLICATION_READ, so the
// client mini-portal cannot read its own pipeline stage there (the call 401s
// and the stage tracker silently defaults to "Received"). Expose a read-only
// stage lookup keyed by application id — the same capability model the
// mini-portal URL already relies on.
router.get(
  "/application-stage",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) {
      res.status(400).json({ error: "applicationId_required" });
      return;
    }
    const result = await dbQuery(
      `select pipeline_state, status, metadata from applications where id::text = ($1)::text limit 1`,
      [applicationId]
    );
    const row = result.rows[0];
    if (!row) {
      res.status(200).json({ found: false });
      return;
    }
    res.status(200).json({
      found: true,
      pipeline_state: row.pipeline_state ?? null,
      status: row.status ?? null,
      metadata: row.metadata ?? null,
    });
  })
);

// BF_SERVER_BLOCK_v712_EMBEDDED_GROUP_SIGNING_v1 — client-accessible embedded
// signing session for the CMP iframe (our application + each finalized lender form).
router.get(
  "/signing-session",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const mod = await import("../../signnow/embeddedSigningSession.js");
    const result = await mod.getOrCreateEmbeddedSigningSession(applicationId);
    res.status(200).json(result);
  })
);

// BF_SERVER_BLOCK_v_CLIENT_SIGNING_COMPLETE_v1 — the SignNow webhook does not
// reliably fire, so the signed stamp + lender-package dispatch never happen.
// The CMP calls this when the signing iframe completes / closes; we VERIFY with
// SignNow (field-invite statuses) that every invite is fulfilled before marking
// signed, so a client can never fake it. On confirmed-signed we run the exact
// finalize path the admin mark-signed route uses.
router.post(
  "/signing-complete",
  safeHandler(async (req: any, res: any) => {
    const applicationId =
      typeof req.query.applicationId === "string"
        ? req.query.applicationId.trim()
        : typeof req.body?.applicationId === "string"
          ? req.body.applicationId.trim()
          : null;
    if (!applicationId) { res.status(400).json({ error: "applicationId_required" }); return; }
    const { pool } = await import("../../db.js");
    const appRes = await pool.query<{ contact_id: string | null; signnow_app_signed_at: string | null; group_id: string | null }>(
      `SELECT contact_id, signnow_app_signed_at,
              (metadata->'signnow_embedded'->>'group_id') AS group_id
         FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    if (!appRes.rows.length) { res.status(404).json({ error: "not_found" }); return; }
    const row = appRes.rows[0];
    if (row.signnow_app_signed_at) { res.json({ ok: true, signed: true, alreadySigned: true }); return; }
    const groupId = row.group_id;
    if (!groupId) { res.json({ ok: true, signed: false, reason: "no_signing_group" }); return; }

    let signed = false; let summary = "";
    try {
      const snow = await import("../../signnow/signnowClient.js");
      const st = await snow.getDocumentGroupStatus(String(groupId));
      signed = !!st.signed; summary = st.summary;
    } catch (e: any) {
      res.json({ ok: true, signed: false, reason: "status_check_failed", detail: e?.message ?? "unknown" });
      return;
    }
    if (!signed) { res.json({ ok: true, signed: false, summary }); return; }

    const { finalizeSignedApplication } = await import("../../signnow/finalizeSignedApplication.js");
    const fired = await finalizeSignedApplication(
      { id: applicationId, contactId: row.contact_id ?? null },
      { documentId: null }
    );
    await pool.query(
      `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now()
         WHERE id::text = ($1)::text
           AND pipeline_state NOT IN ('Off to Lender','Offer','Accepted','Rejected','Declined','Funded','Closed')
           AND EXISTS (SELECT 1 FROM application_packages p
                        WHERE p.application_id::text = ($1)::text AND p.status = 'sent')`,
      [applicationId]
    );
    res.json({ ok: true, signed: true, finalized: fired, summary });
  })
);

router.get(
  "/readiness-prefill",
  safeHandler(async (req: any, res: any) => {
    const phone = typeof req.query.phone === "string" ? req.query.phone.trim() : null;
    const token = typeof req.query.token === "string" ? req.query.token.trim() : null;

    if (!phone && !token) {
      res.status(400).json({ error: "phone_or_token_required" });
      return;
    }

    let row: Record<string, any> | undefined;
    if (token) {
      const result = await dbQuery(
        `select * from readiness_sessions where id = $1 and is_active = true limit 1`,
        [token]
      );
      row = result.rows[0];
    } else {
      // BF_SERVER_BLOCK_v129a_READINESS_PHONE_NORMALIZE_v1
      // Digit-equivalence lookup. Legacy readiness_sessions rows may have
      // raw display format ("(403) 555-1234"); newer rows have E.164
      // ("+14035551234"). Strip both sides to digits. Compare last-10-
      // digit slice so 10-digit and 11-digit (1XXXXXXXXXX) variants both
      // match. Length guard prevents partial-input false positives.
      const result = await dbQuery(
        `select * from readiness_sessions
          where right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10)
                = right(regexp_replace($1, '\D', '', 'g'), 10)
            and length(regexp_replace(coalesce(phone, ''), '\D', '', 'g')) >= 10
            and is_active = true
          order by created_at desc limit 1`,
        [phone]
      );
      row = result.rows[0];
    }

    if (!row) {
      res.status(200).json({ found: false });
      return;
    }

    res.status(200).json({
      found: true,
      prefill: {
        // Identity
        companyName: row.company_name ?? null,
        fullName: row.full_name ?? null,
        email: row.email ?? null,
        phone: row.phone ?? null,
        // Business profile
        industry: row.industry ?? null,
        businessLocation: row.business_location ?? null,
        // Funding profile
        fundingType: row.funding_type ?? null,
        requestedAmount: row.requested_amount ?? null,
        purposeOfFunds: row.purpose_of_funds ?? null,
        // Financial profile (V1 14-field bucket strings)
        salesHistoryYears: row.sales_history_years ?? null,
        annualRevenueRange: row.annual_revenue_range ?? null,
        avgMonthlyRevenueRange: row.avg_monthly_revenue_range ?? null,
        accountsReceivableRange: row.accounts_receivable_range ?? null,
        fixedAssetsValueRange: row.fixed_assets_value_range ?? null,
        // Legacy fields kept for back-compat
        yearsInBusiness: row.years_in_business ?? null,
        annualRevenue: row.annual_revenue ?? null,
        profitable: typeof row.profitable === "boolean" ? row.profitable : null,
        existing_debt: typeof row.existing_debt === "boolean" ? row.existing_debt : null,
        score: row.score ?? null,
      },
    });
  })
);

// BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1
router.get(
  "/messages",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : null;
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }

    // v636: presence bump. Mini-portal polls this every 20s while the tab is
    // visible. POST /communications/messages/send reads last_portal_seen_at to
    // decide whether to fire the offline-fallback SMS.
    await dbQuery(
      `UPDATE applications SET last_portal_seen_at = now() WHERE id = $1`,
      [applicationId]
    ).catch(() => undefined);

    // v636: include `direction` + `cta_label` + `cta_action` so MiniPortalPage
    // maps inbound→self / outbound→other correctly and MessageThread renders
    // the inline CTA bubble (screenshot 2 — "Complete Personal Net Worth").
    const rows = await dbQuery(
      `SELECT id, direction, body, staff_name, cta_label, cta_action, attachments, created_at
       FROM communications_messages
       WHERE application_id = $1
       ORDER BY created_at ASC
       LIMIT 200`,
      [applicationId]
    );

    // BF_SERVER_BLOCK_v778_HIDE_COMPLETED_TASKS — once a client finishes a task
    // (submits a CMP form, uploads the gov-ID / required docs, re-uploads a
    // rejected doc), drop that task's prompt message from the thread so only
    // outstanding to-dos remain. Each lookup degrades to "nothing completed" on
    // error, so a schema surprise just leaves the thread unchanged.
    const v778_forms = await dbQuery(
      `SELECT doc_type FROM application_form_responses WHERE application_id::text = ($1)::text AND submitted_at IS NOT NULL`,
      [applicationId]
    ).catch(() => ({ rows: [] as any[] }));
    const v778_docs = await dbQuery(
      `SELECT DISTINCT lower(coalesce(category,'')) AS category FROM documents WHERE application_id::text = ($1)::text AND coalesce(status,'') <> 'rejected'`,
      [applicationId]
    ).catch(() => ({ rows: [] as any[] }));
    const v778_req = await dbQuery(
      `SELECT lower(coalesce(category,'')) AS category FROM document_requirements WHERE application_id::text = ($1)::text AND required = true AND category IS NOT NULL`,
      [applicationId]
    ).catch(() => ({ rows: [] as any[] }));
    const v778_formKey = (dt: any): string | null => {
      const s = String(dt ?? "").toLowerCase();
      if (/cra/.test(s)) return "cra";
      if (/net.?worth/.test(s)) return "networth";
      if (/advisor/.test(s)) return "advisors";
      if (/debt/.test(s)) return "debt";
      if (/equipment/.test(s)) return "equipment";
      if (/real.?estate/.test(s)) return "realestate";
      if (/flinks|bank/.test(s)) return "flinks";
      return null;
    };
    const v778_completed = new Set<string>();
    for (const r of (v778_forms.rows ?? [])) { const k = v778_formKey((r as any).doc_type); if (k) v778_completed.add(k); }
    const v778_uploaded = new Set<string>((v778_docs.rows ?? []).map((r: any) => String(r.category || "")).filter(Boolean));
    if ([...v778_uploaded].some((c) => /gov|government|photo.?id|identification|\bid\b/.test(c))) v778_completed.add("upload");
    const v778_required: string[] = (v778_req.rows ?? []).map((r: any) => String(r.category || "")).filter(Boolean);
    const v778_stillNeeded = v778_required.filter((c) => !v778_uploaded.has(c));
    if (v778_required.length > 0 && v778_stillNeeded.length === 0) v778_completed.add("upload_docs");
    const V778_TASK_KEYS = new Set<string>(["cra", "networth", "advisors", "debt", "equipment", "realestate", "flinks", "upload", "upload_docs"]);
    const v778_isTask = (cta: any): boolean => { if (!cta) return false; let k = String(cta); if (k.startsWith("form:")) k = k.slice(5); return V778_TASK_KEYS.has(k) || k.startsWith("upload:"); };
    const v778_isDone = (cta: any): boolean => {
      if (!cta) return false;
      let k = String(cta);
      if (k.startsWith("form:")) k = k.slice(5);
      if (k.startsWith("upload:")) {
        const t = k.slice(7).toLowerCase().replace(/[^a-z0-9]/g, "");
        if (!t) return false;
        return [...v778_uploaded].some((c) => { const cc = c.replace(/[^a-z0-9]/g, ""); return !!cc && (cc.includes(t) || t.includes(cc)); });
      }
      return v778_completed.has(k);
    };
    let v778_rows = (rows.rows ?? []).filter((r: any) => !v778_isDone(r.cta_action));
    if (!v778_rows.some((r: any) => v778_isTask(r.cta_action))) {
      v778_rows = v778_rows.filter((r: any) => !(typeof r.body === "string" && /few quick steps to finish/i.test(r.body)));
    }

    res.status(200).json({
      status: "ok",
      data: v778_rows.map((r: any) => ({
        id: r.id,
        direction: r.direction,
        body: r.body,
        staff_name: r.staff_name ?? null,
        cta_label: r.cta_label ?? null,
        cta_action: r.cta_action ?? null,
        attachments: Array.isArray(r.attachments) ? r.attachments : null,
        created_at: r.created_at,
      })),
    });
  })
);

router.post(
  "/messages",
  // BF_SERVER_v64_CLIENT_MSG_ENRICH — populate contact_id + silo from
  // applications so messages from the mini-portal land in the staff
  // portal Communications view (which filters by contact_id + silo).
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : null;
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : null;
    // BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 — accept attachments from the
    // mini-portal (each ≤3MB, up to 5 per message).
    const rawAttach = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const attachments = rawAttach
      .filter((a: any) => a && typeof a.name === "string" && typeof a.dataUrl === "string")
      .slice(0, 5)
      .map((a: any) => ({
        name: String(a.name).slice(0, 200),
        contentType: typeof a.contentType === "string" ? a.contentType.slice(0, 80) : "application/octet-stream",
        dataUrl: String(a.dataUrl).slice(0, 4_500_000),
      }));
    if (!applicationId || (!body && attachments.length === 0)) {
      throw new AppError("validation_error", "applicationId and body or attachments are required.", 400);
    }

    // BF_SERVER_BLOCK_v637_MOBILE_PHONE_AND_BACKFILL_v1 — before insert, backfill
    // applications.contact_id by phone digits-suffix if NULL. Without this the
    // mini-portal message lands with contact_id=NULL, and the staff Messages
    // tab silently drops it (it filters on contact_id presence). Result: the
    // client's send looked "dead" because staff never saw it.
    await dbQuery(
      `UPDATE applications a
          SET contact_id = c.id
         FROM contacts c
        WHERE a.id = $1
          AND a.contact_id IS NULL
          AND a.applicant_phone IS NOT NULL
          AND right(regexp_replace(coalesce(a.applicant_phone,''), '[^0-9]', '', 'g'), 10)
            = right(regexp_replace(coalesce(c.phone,''),            '[^0-9]', '', 'g'), 10)`,
      [applicationId]
    ).catch(() => undefined);

    const id = randomUUID();
    await dbQuery(
      `INSERT INTO communications_messages
         (id, type, direction, status, application_id, contact_id, silo, body, attachments, created_at)
       VALUES (
         $1, 'message', 'inbound', 'received', $2,
         (SELECT contact_id FROM applications WHERE id = $2 LIMIT 1),
         COALESCE((SELECT silo FROM applications WHERE id = $2 LIMIT 1), 'BF'),
         $3,
         CASE WHEN $4::text = '[]' THEN NULL ELSE $4::jsonb END,
         now()
       )`,
      [id, applicationId, body ?? "", JSON.stringify(attachments)]
    );

    // v637: notify staff so client-to-staff messages aren't silent. Best-effort.
    try {
      const { sendStaffNotification } = await import("../../services/notifications/staffSms.js");
      void sendStaffNotification({
        recipients: "available",
        body: `Mini-portal message (app ${applicationId.slice(0,8)}): ${body.length > 140 ? body.slice(0,137) + "…" : body}`,
      }).catch(() => undefined);
    } catch { /* helper missing in some envs */ }

    res.status(201).json({ status: "ok", data: { id } });
  })
);

// ─────────────────────────────────────────────────────────────────────────
// BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1 — mini-portal typing + mark-read
// ─────────────────────────────────────────────────────────────────────────

router.post(
  "/messages/typing",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) throw new AppError("validation_error", "applicationId required.", 400);
    await dbQuery(
      `INSERT INTO messages_typing (contact_id, side, actor_label, updated_at)
       SELECT a.contact_id, 'client', NULL, NOW()
         FROM applications a
        WHERE a.id::text = $1
          AND a.contact_id IS NOT NULL
       ON CONFLICT (contact_id, side)
       DO UPDATE SET updated_at = NOW()`,
      [applicationId]
    ).catch(() => undefined);
    res.json({ ok: true });
  })
);

router.get(
  "/messages/typing",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.query?.applicationId === "string" ? String(req.query.applicationId).trim() : "";
    if (!applicationId) throw new AppError("validation_error", "applicationId required.", 400);
    const r = await dbQuery<{ actor_label: string | null }>(
      `SELECT mt.actor_label
         FROM messages_typing mt
         JOIN applications a ON a.contact_id = mt.contact_id
        WHERE a.id::text = $1
          AND mt.side = 'staff'
          AND mt.updated_at > NOW() - INTERVAL '5 seconds'
        LIMIT 1`,
      [applicationId]
    ).catch(() => ({ rows: [] as any[] }));
    res.json({ typing: r.rows.length > 0, label: r.rows[0]?.actor_label ?? null });
  })
);

router.post(
  "/messages/mark-read",
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) throw new AppError("validation_error", "applicationId required.", 400);
    const r = await dbQuery(
      `UPDATE communications_messages
          SET read_at = NOW()
        WHERE type = 'message'
          AND direction = 'outbound'
          AND read_at IS NULL
          AND application_id::text = $1`,
      [applicationId]
    ).catch(() => ({ rowCount: 0 }));
    res.json({ ok: true, updated: (r as any).rowCount ?? 0 });
  })
);

export default router;
