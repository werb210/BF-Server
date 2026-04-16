import { Router } from "express";
import { CAPABILITIES } from "../auth/capabilities.js";
import { pool } from "../db.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.STAFF_OVERVIEW]));

router.get("/overview", safeHandler(async (_req: any, res: any) => {
  const [apps, recent] = await Promise.all([
    pool.query<{ stage: string; count: string }>(
      `SELECT pipeline_state AS stage, COUNT(*)::text AS count
       FROM applications
       WHERE pipeline_state NOT IN ($1, $2)
       GROUP BY pipeline_state`,
      [ApplicationStage.ACCEPTED, ApplicationStage.REJECTED]
    ),
    pool.query<{ id: string; name: string; pipeline_state: string; updated_at: Date }>(
      `SELECT id, coalesce(name, business_legal_name, 'Unnamed') AS name,
              pipeline_state, updated_at
       FROM applications ORDER BY updated_at DESC LIMIT 5`
    ),
  ]);

  const byStage: Record<string, number> = {};
  (apps.rows ?? []).forEach((r: any) => {
    byStage[r.stage] = parseInt(r.count, 10);
  });

  res.json({
    status: "ok",
    data: {
      pipelineByStage: byStage,
      recentApplications: recent.rows ?? [],
    },
  });
}));

export default router;
