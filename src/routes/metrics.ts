import type { Request, Response } from "express";
import { Router } from "express";

import { getMetrics } from "@/system/metrics";

export function metricsRoute(_req: Request, res: Response) {
  return res.json({
    status: "ok",
    data: getMetrics(),
  });
}

const router = Router();
router.get("/metrics", metricsRoute);

export default router;
