import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();

export function health(_req: Request, res: Response) {
  return res.status(200).json({ status: "ok" });
}

router.get("/health", health);
router.get("/healthz", health);

export default router;
