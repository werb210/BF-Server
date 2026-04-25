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
      `SELECT COUNT(*)::text AS count FROM applications
       WHERE (silo = $3 OR silo IS NULL)
         AND pipeline_state NOT IN ($1, $2)`,
      [ApplicationStage.ACCEPTED, ApplicationStage.REJECTED, silo]
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM applications
       WHERE (silo = $2 OR silo IS NULL)
         AND pipeline_state = $1
         AND updated_at >= date_trunc('month', now())`,
      [ApplicationStage.ACCEPTED, silo]
    ),
    pool.query<{ stage: string; count: string }>(
      `SELECT pipeline_state AS stage, COUNT(*)::text AS count
       FROM applications
       WHERE (silo = $3 OR silo IS NULL)
         AND pipeline_state NOT IN ($1, $2)
       GROUP BY pipeline_state`,
      [ApplicationStage.ACCEPTED, ApplicationStage.REJECTED, silo]
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

router.get("/actions", safeHandler(async (_req: any, res: any) => {
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

router.get("/pipeline", safeHandler(async (_req: any, res: any) => {
  res.json({ stages: [] });
}));

export default router;
