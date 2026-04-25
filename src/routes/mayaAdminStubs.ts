import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = Router();
const adminOnly = [
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
];

router.get(
  "/overview",
  ...adminOnly,
  safeHandler(async (_req, res) => {
    res.json({
      data: {
        implemented: false,
        totalConversations: 0,
        escalations: 0,
        avgResponseSeconds: 0,
        modelVersion: process.env.OPENAI_MODEL || "gpt-4o-mini",
      },
    });
  })
);

router.get(
  "/metrics",
  ...adminOnly,
  safeHandler(async (_req, res) => {
    res.json({
      data: {
        implemented: false,
        messages24h: 0,
        escalations24h: 0,
        p50LatencyMs: null,
        p95LatencyMs: null,
      },
    });
  })
);

router.post(
  "/roi-simulate",
  ...adminOnly,
  safeHandler(async (req, res) => {
    const budget = Number((req.body as { budget?: unknown })?.budget) || 0;
    res.json({
      data: {
        implemented: false,
        budget,
        projectedDeals: 0,
        projectedRevenue: 0,
        note: "ROI simulation not yet wired to live data.",
      },
    });
  })
);

router.post(
  "/model-rollback",
  ...adminOnly,
  safeHandler(async (_req, res) => {
    res.status(501).json({
      error: "not_implemented",
      message: "Model rollback is not yet implemented.",
    });
  })
);

export default router;
