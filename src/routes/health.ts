import { Router } from "express";
import { isReady } from "../system/ready";
import type { Request, Response } from "express";
import { error, ok } from "../lib/response";

const router = Router();

export function health(_req: Request, res: Response) {
  const payload = { status: "ok" };
  return res.json(payload);
}

export function ready(req: Request, res: Response) {
  if (!isReady()) {
    return res.status(503).json(error("NOT_READY", (req as Request & { rid?: string }).rid));
  }

  return res.json(ok({ status: "ready" }, (req as Request & { rid?: string }).rid));
}

router.get("/health", health);
router.get("/healthz", health);
router.get("/ready", ready);
router.get("/readyz", ready);

export default router;
