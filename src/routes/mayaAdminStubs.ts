import { Router } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { auth } from "../middleware/auth.js";

const router = Router();

router.get(
  "/overview",
  auth,
  safeHandler(async (_req: any, res: any) => {
    res.json({
      status: "ok",
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
  auth,
  safeHandler(async (_req: any, res: any) => {
    res.json({
      status: "ok",
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
  auth,
  safeHandler(async (req: any, res: any) => {
    const budget = Number((req.body as { budget?: unknown })?.budget) || 0;
    res.json({
      status: "ok",
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
  auth,
  safeHandler(async (_req: any, res: any) => {
    res.status(501).json({
      error: "not_implemented",
      message: "Model rollback is not yet implemented.",
    });
  })
);

export default router;
