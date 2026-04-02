import { Router } from "express";
import { isReady } from "../system/ready";
import type { Request, Response } from "express";

const router = Router();

export function health(_req: Request, res: Response) {
  return res.status(200).json({ status: "ok" });
}

export function ready(_req: Request, res: Response) {
  if (!isReady()) {
    return res.status(503).json({ status: "not_ready" });
  }

  return res.json({ status: "ready" });
}

router.get("/health", health);

router.get("/healthz", health);

router.get("/ready", ready);

router.get("/readyz", ready);

export default router;
