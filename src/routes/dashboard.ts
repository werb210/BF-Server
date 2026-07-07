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
    // amount = the accepted term sheet amount when one exists (offers.amount,
    // status='accepted'), else the requested_amount. Grouped into the same board
    // columns as the counts above so the dashboard can show a commission figure
    // sitting in every stage, not just earned. (lender_products.id is text;
    // applications.lender_product_id is uuid, so the join casts to text.)
    pool.query<{ stage: string; commission: string }>(
      `SELECT (CASE WHEN a.pipeline_state IN
                 ('Received','In Review','Documents Required','Additional Steps Required','Off to Lender','Offer','Accepted','Rejected')
               THEN a.pipeline_state ELSE 'Received' END) AS stage,
              COALESCE(SUM(
                COALESCE(off.amount, a.requested_amount, 0)
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

router.get("/document-health", requireAuth, safeHandler(async (_req: any, res: any) => {
  res.json({ status: "ok", data: {} });
}));

router.get("/lender-activity", requireAuth, safeHandler(async (_req: any, res: any) => {
  res.json({ status: "ok", data: {} });
}));

router.get("/offers", requireAuth, safeHandler(async (_req: any, res: any) => {
  res.json({ status: "ok", data: [] });
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
