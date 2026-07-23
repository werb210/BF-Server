import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";

const router = Router();

router.get("/", requireAuth, safeHandler(async (_req: any, res: any) => {
  res.json({ ok: true });
}));

router.get("/metrics", requireAuth, safeHandler(async (_req: any, res: any) => { // BF_SERVER_BLOCK_v829_DEALS_NOT_COMPANIONS
  const silo = getSilo(res);
  const [active, won, stageRows, commissionRows] = await Promise.all([
    pool.query<{ count: string }>(
      // BF_SERVER_BLOCK_v786_DASHBOARD_MATCH_BOARD — count exactly what the
      // Pipeline board shows: the same source/filter as GET /api/portal/applications
      // (UPPER(silo) match, drafts excluded). Accepted/Rejected are NOT excluded so
      // the headline number matches the board's "N applications" header.
      // BF_SERVER_BLOCK_v838_DASHBOARD_EXCLUDE_NAMELESS — match the board, which
      // hides nameless "draft-like" rows client-side (isDraftLikeApplication).
      `SELECT COUNT(*)::text AS count FROM applications
       WHERE UPPER(silo) = UPPER($1)
         AND parent_application_id IS NULL  -- v829: count DEALS, not companion legs
         AND COALESCE(pipeline_state, '') NOT IN ('draft', 'Draft', '')
         AND COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(business_legal_name), '')) IS NOT NULL
         AND LOWER(TRIM(COALESCE(name, business_legal_name, ''))) NOT IN ('draft', 'draft application') -- BF_SERVER_BLOCK_v844_DASHBOARD_EXCLUDE_DRAFT_NAMES`,
      [silo]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM applications
       WHERE UPPER(silo) = UPPER($2)
         AND parent_application_id IS NULL  -- v829: count DEALS, not companion legs
         AND pipeline_state = $1
         AND updated_at >= date_trunc('month', now())`,
      [ApplicationStage.ACCEPTED, silo]
    ),
    pool.query<{ stage: string; count: string }>(
      // Bucket into the board's columns; any unknown state falls to "Received",
      // matching the board's effectiveStage().
      `SELECT (CASE WHEN pipeline_state IN
                 ('Received','In Review','Documents Required','Additional Steps Required','Off to Lender','Offer','Accepted','Rejected')
               THEN pipeline_state ELSE 'Received' END) AS stage,
              COUNT(*)::text AS count
       FROM applications
       WHERE UPPER(silo) = UPPER($1)
         AND parent_application_id IS NULL  -- v829: count DEALS, not companion legs
         AND COALESCE(pipeline_state, '') NOT IN ('draft', 'Draft', '')
         AND COALESCE(NULLIF(TRIM(name), ''), NULLIF(TRIM(business_legal_name), '')) IS NOT NULL
         AND LOWER(TRIM(COALESCE(name, business_legal_name, ''))) NOT IN ('draft', 'draft application') -- BF_SERVER_BLOCK_v844_DASHBOARD_EXCLUDE_DRAFT_NAMES  -- BF_SERVER_BLOCK_v838_DASHBOARD_EXCLUDE_NAMELESS
       GROUP BY 1`,
      [silo]
    ),
    // BF_SERVER_DASHBOARD_COMMISSION_v1 - projected BF commission per pipeline
    // stage. BF earns 2% of the funded amount unless the chosen product carries
    // a commission override (lender_products.commission, a percent). Funded
    // amount = applications.funded_amount (the ACTUAL advance, entered by staff at
    // acceptance) when set; else the accepted term sheet amount (offers.amount,
    // status='accepted'); else the requested_amount. Grouped into the same board
    // columns as the counts above so the dashboard can show a commission figure
    // sitting in every stage, not just earned. (lender_products.id is text;
    // applications.lender_product_id is uuid, so the join casts to text.)
    pool.query<{ stage: string; commission: string }>(
      `SELECT (CASE WHEN a.pipeline_state IN
                 ('Received','In Review','Documents Required','Additional Steps Required','Off to Lender','Offer','Accepted','Rejected')
               THEN a.pipeline_state ELSE 'Received' END) AS stage,
              COALESCE(SUM(
                COALESCE(a.funded_amount, off.amount, a.requested_amount, 0)
                * (COALESCE(lp.commission, 2) / 100.0)
              ), 0)::text AS commission
       FROM applications a
       LEFT JOIN lender_products lp ON lp.id = a.lender_product_id::text
       LEFT JOIN LATERAL (
         SELECT o.amount FROM offers o
          WHERE o.application_id = a.id AND o.status = 'accepted'
          ORDER BY o.updated_at DESC NULLS LAST
          LIMIT 1
       ) off ON TRUE
       WHERE UPPER(a.silo) = UPPER($1)
         AND a.parent_application_id IS NULL
         AND COALESCE(a.pipeline_state, '') NOT IN ('draft', 'Draft', '')
         AND COALESCE(NULLIF(TRIM(a.name), ''), NULLIF(TRIM(a.business_legal_name), '')) IS NOT NULL
         AND LOWER(TRIM(COALESCE(a.name, a.business_legal_name, ''))) NOT IN ('draft', 'draft application')
       GROUP BY 1`,
      [silo]
    ),
  ]);

  const pipelineByStage: Record<string, number> = {};
  (stageRows.rows ?? []).forEach((r: any) => {
    pipelineByStage[r.stage] = parseInt(r.count, 10);
  });

  // BF_SERVER_DASHBOARD_COMMISSION_v1 - projected commission per stage + the
  // earned figure (the Accepted bucket = commission on funded deals).
  const commissionByStage: Record<string, number> = {};
  (commissionRows.rows ?? []).forEach((r: any) => {
    commissionByStage[r.stage] = Math.round((Number(r.commission) || 0) * 100) / 100;
  });
  const commissionEarned = commissionByStage["Accepted"] ?? 0;

  res.json({
    status: "ok",
    data: {
      activeApplications: parseInt(active.rows[0]?.count ?? "0", 10),
      dealsWonThisMonth: parseInt(won.rows[0]?.count ?? "0", 10),
      commissionEarned,
      newLeadsToday: 0,
      pipelineByStage,
      commissionByStage,
    },
  });
}));

// BF_SERVER_BLOCK_v822_DASHBOARD_PIPELINE_ACTIONS — real urgent-action counts.
router.get("/actions", requireAuth, safeHandler(async (_req: any, res: any) => {
  const silo = getSilo(res);
  const [waiting, missing, expiring, awaiting] = await Promise.all([
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM applications
        WHERE UPPER(silo) = UPPER($1)
          AND COALESCE(pipeline_state,'') NOT IN ('draft','Draft','','Accepted','Rejected')
          AND updated_at < now() - interval '24 hours'`,
      [silo],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT a.id)::text AS count
         FROM applications a
         JOIN application_required_documents rd ON rd.application_id = a.id
        WHERE UPPER(a.silo) = UPPER($1)
          AND rd.status IN ('required','missing')`,
      [silo],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM offers o JOIN applications a ON a.id = o.application_id
        WHERE UPPER(a.silo) = UPPER($1)
          AND o.expiry_date IS NOT NULL
          AND o.expiry_date <= (now() + interval '2 days')::date
          AND o.expiry_date >= now()::date`,
      [silo],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM applications
        WHERE UPPER(silo) = UPPER($1)
          AND pipeline_state = 'Additional Steps Required'`,
      [silo],
    ),
  ]);
  res.json({
    waitingOver24h:         parseInt(waiting.rows[0]?.count ?? "0", 10),
    missingDocuments:       parseInt(missing.rows[0]?.count ?? "0", 10),
    offersExpiring:         parseInt(expiring.rows[0]?.count ?? "0", 10),
    awaitingClientResponse: parseInt(awaiting.rows[0]?.count ?? "0", 10),
  });
}));

// BF_SERVER_DASHBOARD_ANALYTICS_v1
// /document-health, /lender-activity and /offers were stubs returning {} / [].
// The BF-portal components that consume them (DocumentHealth.tsx,
// LenderActivity.tsx, OfferFeed.tsx) therefore had nothing to render and were
// never mounted on the live dashboard page. They now return real, silo-scoped
// aggregates.
//
// Every query below is silo-scoped and read-only. Date windows come from a
// ?days= query param (1..365, default 30) so the dashboard's range selector
// drives them all consistently.

function windowDays(req: any): number {
  const raw = Number(req?.query?.days);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(Math.max(Math.round(raw), 1), 365);
}

// Document upload issues: which document types actually cause trouble. Counts
// rejections and stalled OCR per category so staff can see WHICH document is
// costing them deals rather than just "N documents missing".
router.get("/document-health", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const days = windowDays(req);
  const r = await pool.query<{
    category: string; total: string; rejected: string; pending: string; ocr_failed: string;
  }>(
    `SELECT COALESCE(NULLIF(d.category, ''), 'Uncategorized') AS category,
            COUNT(*)::text                                                        AS total,
            COUNT(*) FILTER (WHERE d.status = 'rejected')::text                   AS rejected,
            COUNT(*) FILTER (WHERE d.status NOT IN ('accepted','rejected')
                               OR d.status IS NULL)::text                         AS pending,
            COUNT(*) FILTER (WHERE d.ocr_status = 'failed')::text                 AS ocr_failed
       FROM documents d
       JOIN applications a ON a.id = d.application_id
      WHERE UPPER(a.silo) = UPPER($1)
        AND d.created_at >= now() - ($2 || ' days')::interval
      GROUP BY 1
      ORDER BY COUNT(*) FILTER (WHERE d.status = 'rejected') DESC, COUNT(*) DESC
      LIMIT 12`,
    [silo, String(days)],
  ).catch(() => ({ rows: [] as any[] }));

  const rows = r.rows.map((x) => {
    const total = parseInt(x.total, 10) || 0;
    const rejected = parseInt(x.rejected, 10) || 0;
    return {
      category: x.category,
      total,
      rejected,
      pending: parseInt(x.pending, 10) || 0,
      ocrFailed: parseInt(x.ocr_failed, 10) || 0,
      rejectRate: total > 0 ? Math.round((rejected / total) * 1000) / 10 : 0,
    };
  });
  res.json({ status: "ok", data: { days, rows } });
}));

// Top lenders by approval rate. "Sent" is a package actually delivered
// (application_packages.status='sent'), "approved" is an offer existing from
// that lender for that application. Lenders with no sends are omitted rather
// than shown as 0% - a lender nobody submitted to has no approval rate, and
// rendering 0% would defame them.
router.get("/lender-activity", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const days = windowDays(req);
  const r = await pool.query<{
    lender_id: string; lender_name: string; sent: string; approved: string; funded: string;
  }>(
    `WITH sent AS (
       SELECT p.lender_id::text AS lender_id, p.application_id
         FROM application_packages p
         JOIN applications a ON a.id::text = p.application_id::text
        WHERE UPPER(a.silo) = UPPER($1)
          AND p.status = 'sent'
          AND p.created_at >= now() - ($2 || ' days')::interval
     ),
     offered AS (
       SELECT DISTINCT o.lender_id::text AS lender_id, o.application_id::text AS application_id,
              o.status AS offer_status
         FROM offers o
        WHERE COALESCE(o.is_archived, false) = false
     )
     SELECT s.lender_id,
            COALESCE(l.name, 'Unknown lender')                                   AS lender_name,
            COUNT(DISTINCT s.application_id)::text                               AS sent,
            COUNT(DISTINCT o.application_id)::text                               AS approved,
            COUNT(DISTINCT o.application_id) FILTER (
              WHERE LOWER(COALESCE(o.offer_status, '')) IN ('accepted','funded')
            )::text                                                              AS funded
       FROM sent s
       LEFT JOIN lenders l ON l.id::text = s.lender_id
       LEFT JOIN offered o
              ON o.lender_id = s.lender_id
             AND o.application_id = s.application_id::text
      GROUP BY s.lender_id, l.name
      ORDER BY COUNT(DISTINCT s.application_id) DESC
      LIMIT 12`,
    [silo, String(days)],
  ).catch(() => ({ rows: [] as any[] }));

  const rows = r.rows.map((x) => {
    const sent = parseInt(x.sent, 10) || 0;
    const approved = parseInt(x.approved, 10) || 0;
    return {
      lenderId: x.lender_id,
      lenderName: x.lender_name,
      sent,
      approved,
      funded: parseInt(x.funded, 10) || 0,
      approvalRate: sent > 0 ? Math.round((approved / sent) * 1000) / 10 : 0,
    };
  });
  res.json({ status: "ok", data: { days, rows } });
}));

router.get("/offers", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const days = windowDays(req);
  const r = await pool.query(
    `SELECT o.id::text AS id, o.application_id::text AS "applicationId",
            a.name AS "applicationName",
            COALESCE(l.name, 'Unknown lender') AS "lenderName",
            o.amount, o.status, o.created_at AS "createdAt"
       FROM offers o
       JOIN applications a ON a.id = o.application_id
       LEFT JOIN lenders l ON l.id = o.lender_id
      WHERE UPPER(a.silo) = UPPER($1)
        AND COALESCE(o.is_archived, false) = false
        AND o.created_at >= now() - ($2 || ' days')::interval
      ORDER BY o.created_at DESC
      LIMIT 25`,
    [silo, String(days)],
  ).catch(() => ({ rows: [] as any[] }));
  res.json({ status: "ok", data: r.rows });
}));

// Application funnel by wizard step, plus where applicants drop off.
// Mirrors /api/marketing/funnel but silo-scoped and windowed, so the dashboard
// does not have to reach into the marketing module. Empty-shell drafts (never
// progressed past step 1, never submitted) are excluded - they are abandoned
// page-loads, not real applicants, and counting them makes step-1 drop-off look
// catastrophic.
router.get("/funnel", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const days = windowDays(req);
  const r = await pool.query<Record<string, string>>(
    `WITH stepped AS (
       -- BF_SERVER_FUNNEL_STEP_KEY_v1
       -- The wizard step lives at metadata->>'currentStep' (camelCase).
       -- bfBuildWizardMetadata in src/routes/client/v1Applications.ts accepts
       -- both spellings from the client but normalises them to a single
       -- camelCase key, so metadata->>'current_step' is NEVER populated. Reading
       -- only the snake_case name meant every row fell through to the
       -- current_step column (null) and defaulted to 1 - the funnel reported
       -- every application, including submitted ones, as stuck on step 1.
       -- Read camelCase first, keep the other two as fallbacks.
       SELECT COALESCE(
                NULLIF(metadata->>'currentStep','')::int,
                NULLIF(metadata->>'current_step','')::int,
                current_step, 1) AS step,
              submitted_at
         FROM applications
        WHERE UPPER(silo) = UPPER($1)
          AND created_at >= now() - ($2 || ' days')::interval
          AND NOT (submitted_at IS NULL
                   AND COALESCE(
                         NULLIF(metadata->>'currentStep','')::int,
                         NULLIF(metadata->>'current_step','')::int,
                         current_step, 1) <= 1)
     )
     SELECT COUNT(*)::text AS started,
            COUNT(*) FILTER (WHERE step >= 2 OR submitted_at IS NOT NULL)::text AS step2,
            COUNT(*) FILTER (WHERE step >= 3 OR submitted_at IS NOT NULL)::text AS step3,
            COUNT(*) FILTER (WHERE step >= 4 OR submitted_at IS NOT NULL)::text AS step4,
            COUNT(*) FILTER (WHERE step >= 5 OR submitted_at IS NOT NULL)::text AS step5,
            COUNT(*) FILTER (WHERE step >= 6 OR submitted_at IS NOT NULL)::text AS step6,
            COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)::text AS submitted
       FROM stepped`,
    [silo, String(days)],
  ).catch(() => ({ rows: [] as any[] }));

  const n = (k: string) => parseInt(r.rows[0]?.[k] ?? "0", 10) || 0;
  const STEP_LABELS = [
    "Begin application", "Business info", "Financial info",
    "Documents", "Lender selection", "Submitted",
  ];
  const counts = [n("started"), n("step2"), n("step3"), n("step4"), n("step5"), n("step6")];
  const steps = counts.map((count, i) => {
    const prev = i === 0 ? counts[0] : counts[i - 1];
    const dropped = i === 0 ? 0 : Math.max(prev - count, 0);
    return {
      label: STEP_LABELS[i],
      count,
      dropped,
      conversionFromPrev: prev > 0 ? Math.round((count / prev) * 1000) / 10 : 0,
    };
  });
  // Biggest leaks first - this is the panel staff act on.
  const dropOffs = steps
    .filter((x) => x.dropped > 0)
    .sort((a, b) => b.dropped - a.dropped)
    .slice(0, 5);

  res.json({
    status: "ok",
    data: { days, steps, dropOffs, submitted: n("submitted") },
  });
}));

// Funding rate by product type: of the applications requesting each product,
// how many reached a funded state.
router.get("/funding-by-product", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const days = windowDays(req);
  const r = await pool.query<{ product: string; total: string; funded: string }>(
    `SELECT COALESCE(NULLIF(product_category, ''), 'Unspecified') AS product,
            COUNT(*)::text                                        AS total,
            COUNT(*) FILTER (
              WHERE pipeline_state = $3 OR funded_amount IS NOT NULL
            )::text                                               AS funded
       FROM applications
      WHERE UPPER(silo) = UPPER($1)
        AND created_at >= now() - ($2 || ' days')::interval
        AND COALESCE(pipeline_state, '') NOT IN ('draft','Draft','')
      GROUP BY 1
      ORDER BY COUNT(*) DESC
      LIMIT 10`,
    [silo, String(days), ApplicationStage.ACCEPTED],
  ).catch(() => ({ rows: [] as any[] }));

  const rows = r.rows.map((x) => {
    const total = parseInt(x.total, 10) || 0;
    const funded = parseInt(x.funded, 10) || 0;
    return {
      product: x.product,
      total,
      funded,
      fundingRate: total > 0 ? Math.round((funded / total) * 1000) / 10 : 0,
    };
  });
  res.json({ status: "ok", data: { days, rows } });
}));

// Acquisition: GA4 sessions by channel joined to applications attributed to the
// same channel, plus Google Ads spend so cost-per-application is real rather
// than a placeholder.
//
// Any of the three sources may be unconfigured; each is reported independently
// via a `configured` flag rather than failing the whole panel. A dashboard that
// 500s because one integration is unset is worse than one that renders what it
// has and says what is missing.
router.get("/acquisition", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const days = windowDays(req);

  // Channel comes from the application's own attribution blob, the same source
  // /api/marketing/sources uses. contact_ad_attribution deliberately is NOT used
  // here: it only ever holds Google Ads clicks (gclid, campaign, keyword) and has
  // no channel column, so joining to it would classify every non-Google visitor
  // as unattributed.
  //
  // The host is extracted with split_part rather than a regexp backreference on
  // purpose: a backreference has to survive both TS template-literal escaping and
  // the SQL literal, and getting that wrong fails silently (the replacement comes
  // back as a literal backslash-1 instead of the captured host). split_part has no
  // escaping at all.
  const appsByChannel = await pool.query<{ channel: string; applications: string }>(
    `SELECT COALESCE(
              NULLIF(a.metadata->'attribution'->>'utm_source', ''),
              NULLIF(split_part(
                split_part(COALESCE(a.metadata->'attribution'->>'referrer',''), '//', 2),
                '/', 1), ''),
              'Direct'
            ) AS channel,
            COUNT(DISTINCT a.id)::text AS applications
       FROM applications a
      WHERE UPPER(a.silo) = UPPER($1)
        AND a.created_at >= now() - ($2 || ' days')::interval
        AND COALESCE(a.pipeline_state, '') NOT IN ('draft','Draft','')
      GROUP BY 1
      ORDER BY COUNT(DISTINCT a.id) DESC`,
    [silo, String(days)],
  ).catch(() => ({ rows: [] as any[] }));

  let ga4: any = { configured: false };
  try {
    const mod = await import("../services/ga4Service.js");
    if (typeof (mod as any).ga4Configured === "function" && (mod as any).ga4Configured()) {
      ga4 = (await (mod as any).runGa4Report(days)) ?? { configured: false };
    }
  } catch { ga4 = { configured: false }; }

  let ads: any = { configured: false };
  try {
    const mod = await import("../services/googleAdsService.js");
    if (typeof (mod as any).googleAdsConfigured === "function" && (mod as any).googleAdsConfigured()) {
      ads = (await (mod as any).runGoogleAdsReport(days)) ?? { configured: false };
    }
  } catch { ads = { configured: false }; }

  const sessionsByChannel: Record<string, number> = {};
  for (const row of (ga4?.channels ?? []) as Array<{ dim: string; sessions: number }>) {
    if (row?.dim) sessionsByChannel[String(row.dim)] = Number(row.sessions) || 0;
  }

  const adSpend = Number(ads?.totals?.cost ?? 0);
  const rows = appsByChannel.rows.map((x) => {
    const applications = parseInt(x.applications, 10) || 0;
    const sessions = sessionsByChannel[x.channel] ?? 0;
    // Spend is only attributable to paid Google traffic; do not smear it across
    // organic or direct, which would invent a cost that was never incurred.
    const isPaidGoogle = /paid search|google ads/i.test(x.channel);
    const cost = isPaidGoogle ? adSpend : 0;
    return {
      channel: x.channel,
      sessions,
      applications,
      applicationRate: sessions > 0 ? Math.round((applications / sessions) * 1000) / 10 : null,
      cost,
      costPerApplication: cost > 0 && applications > 0
        ? Math.round((cost / applications) * 100) / 100
        : null,
    };
  });

  res.json({
    status: "ok",
    data: {
      days,
      rows,
      totals: {
        sessions: Number(ga4?.summary?.sessions ?? 0),
        applications: rows.reduce((a, b) => a + b.applications, 0),
        adSpend,
      },
      sources: {
        ga4: Boolean(ga4?.configured) && !ga4?.error,
        googleAds: Boolean(ads?.configured),
        attribution: rows.some((r) => r.channel !== "Direct"),
      },
    },
  });
}));

// BF_SERVER_BLOCK_v822_DASHBOARD_PIPELINE_ACTIONS — real silo-scoped pipeline counts.
router.get("/pipeline", requireAuth, safeHandler(async (_req: any, res: any) => {
  const silo = getSilo(res);
  const r = await pool.query<{ stage: string; count: string }>(
    `SELECT pipeline_state AS stage, COUNT(*)::text AS count
       FROM applications
      WHERE UPPER(silo) = UPPER($1)
        AND COALESCE(pipeline_state, '') NOT IN ('draft','Draft','')
      GROUP BY pipeline_state`,
    [silo],
  );
  const by: Record<string, number> = {};
  (r.rows ?? []).forEach((x: any) => { by[String(x.stage)] = parseInt(x.count, 10); });
  res.json({
    newApplications: by["Received"] ?? 0,
    inReview:        by["In Review"] ?? 0,
    requiresDocs:    (by["Documents Required"] ?? 0) + (by["Additional Steps Required"] ?? 0),
    sentToLender:    by["Off to Lender"] ?? 0,
    offersReceived:  by["Offer"] ?? 0,
    closed:          by["Accepted"] ?? 0,
    declined:        by["Rejected"] ?? 0,
  });
}));

export default router;
