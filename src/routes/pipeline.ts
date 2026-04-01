import { Router } from "express";
import { pool } from "../db";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { fetchPipelineStates } from "../modules/applications/applications.service";
import { ApplicationStage } from "../modules/applications/pipelineState";

const router = Router();

router.get(
  "/",
  requireAuth,
  requireCapability([CAPABILITIES.APPLICATION_READ]),
  safeHandler(async (_req: any, res: any) => {
    const result = await pool.runQuery<{
      id: string;
      name: string | null;
      pipeline_state: string | null;
      updated_at: Date;
    }>(
      `select id, name, pipeline_state, updated_at
       from applications
       order by updated_at desc`
    );
    res.status(200).json({
      items: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        stage: row.pipeline_state ?? ApplicationStage.RECEIVED,
        updatedAt: row.updated_at,
      })),
    });
  })
);

router.get(
  "/stages",
  requireAuth,
  requireCapability([CAPABILITIES.APPLICATION_READ]),
  safeHandler(async (_req: any, res: any) => {
    res.status(200).json({ stages: fetchPipelineStates() });
  })
);

export default router;
