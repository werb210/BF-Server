import type { Request, Response } from "express";
import { Router } from "express";
import { fetchStatus, isReady } from "../startupState";

const router = Router();

export function healthHandler(_req: Request, res: Response): void {
  res.status(200).json({ ok: true });
}

export function readyHandler(_req: Request, res: Response): void {
  if (!isReady()) {
    const status = fetchStatus();
    res.status(503).json({
      ok: false,
      code: "service_not_ready",
      reason: status.reason,
    });
    return;
  }
  res.status(200).json({ ok: true });
}

router.get("/health", healthHandler);
router.get("/ready", readyHandler);

export default router;
