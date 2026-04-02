import type { Request, Response } from "express";
import { Router } from "express";
import { isReady } from "../startupState";

const router = Router();

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ ok: true });
}

export function readyHandler(_req: Request, res: Response): void {
  if (!isReady()) {
    res.status(503).json({ status: "not_ready" });
    return;
  }
  res.status(200).json({ ok: true });
}

router.get("/health", healthHandler);
router.get("/ready", readyHandler);

export default router;
