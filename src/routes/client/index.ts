import { randomUUID } from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import continuationRouter from "./continuation.js";
import documentsRouter from "./documents.js";
import applicationsRouter from "./applications.js";
import lendersRouter from "./lenders.js";
import lenderProductsRouter from "./lenderProducts.js";
import clientSubmissionRoutes from "../../modules/clientSubmission/clientSubmission.routes.js";
import sessionRouter from "./session.js";
import {
  clientDocumentsRateLimit,
  clientReadRateLimit,
} from "../../middleware/rateLimit.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";
import { AppError } from "../../middleware/errors.js";

const router = Router();
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
    const r = await dbQuery(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
              )::int AS mine
         FROM crm_contacts
        WHERE application_id::text = ($1)::text`,
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

    res.status(200).json({
      status: "ok",
      data: (rows.rows ?? []).map((r: any) => ({
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
