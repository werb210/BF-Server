import { Router } from "express";
import { runQuery } from "../db.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { fetchPipelineStates } from "../modules/applications/applications.service.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";
const router = Router();
router.get("/", requireAuth, requireCapability([CAPABILITIES.APPLICATION_READ]), safeHandler(async (_req, res) => {
    const result = await runQuery(`select id, name, pipeline_state, updated_at
       from applications
       order by updated_at desc`);
    res.status(200).json({
        items: result.rows.map((row) => ({
            id: row.id,
            name: row.name,
            stage: row.pipeline_state ?? ApplicationStage.RECEIVED,
            updatedAt: row.updated_at,
        })),
    });
}));
router.get("/stages", requireAuth, requireCapability([CAPABILITIES.APPLICATION_READ]), safeHandler(async (_req, res) => {
    res.status(200).json({ stages: fetchPipelineStates() });
}));
export default router;
