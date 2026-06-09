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

router.get("/metrics", requireAuth, safeHandler(async (_req: any, res: any) => {
  const silo = getSilo(res);
  const [active, won, stageRows] = await Promise.all([
    pool.query<{ count: string }>(
      // BF_SERVER_BLOCK_v786_DASHBOARD_MATCH_BOARD — count exactly what the
      // Pipeline board shows: the same source/filter as GET /api/portal/applications
      // (UPPER(silo) match, drafts excluded). Accepted/Rejected are NOT excluded so
      // the headline number matches the board's "N applications" header.
      `SELECT COUNT(*)::text AS count FROM applications
       WHERE UPPER(silo) = UPPER($1)
         AND COALESCE(pipeline_state, '') NOT IN ('draft', 'Draft', '')`,
      [silo]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM applications
       WHERE UPPER(silo) = UPPER($2)
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
         AND COALESCE(pipeline_state, '') NOT IN ('draft', 'Draft', '')
       GROUP BY 1`,
      [silo]
    ),
  ]);

  const pipelineByStage: Record<string, number> = {};
  (stageRows.rows ?? []).forEach((r: any) => {
    pipelineByStage[r.stage] = parseInt(r.count, 10);
  });

  res.json({
    status: "ok",
    data: {
      activeApplications: parseInt(active.rows[0]?.count ?? "0", 10),
      dealsWonThisMonth: parseInt(won.rows[0]?.count ?? "0", 10),
      commissionEarned: 0,
      newLeadsToday: 0,
      pipelineByStage,
    },
  });
}));

// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — gate /actions (AUDIT-10 regression repair)
router.get("/actions", requireAuth, safeHandler(async (_req: any, res: any) => {
  res.json({ count: 0 });
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

// BF_SERVER_BLOCK_v138_E2E_FIX_BATCH_v1 — gate /pipeline (AUDIT-10 regression repair)
router.get("/pipeline", requireAuth, safeHandler(async (_req: any, res: any) => {
  res.json({ stages: [] });
}));

export default router;
