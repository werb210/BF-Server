import { Router } from "express";
import { dbHealth } from "../health/dbHealth";
import { getStatus } from "../startupState";

const router = Router();

router.get("/healthz", async (_req, res) => {
  const health = await dbHealth();
  const ok = health.db === "ok";
  res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", ...health });
});

router.get("/readyz", (_req, res) => {
  const status = getStatus();
  const ready = status.ready && !status.reason;
  res.status(ready ? 200 : 503).json({ ready, status });
});

export default router;
