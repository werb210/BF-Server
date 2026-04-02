import { Router } from "express";
import type { Request, Response } from "express";

const router = Router();

export function readyHandler(req: Request, res: Response) {
  const deps = req.app.locals.deps;

  if (!deps || !deps.db) {
    return res.status(503).json({ status: "not_ready" });
  }

  if (!deps.db.ready) {
    return res.status(503).json({ status: "not_ready" });
  }

  return res.status(200).json({ status: "ok" });
}

router.get("/", readyHandler);
router.get("/ready", readyHandler);

export default router;
