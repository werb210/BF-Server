import { Router } from "express";
import { deps } from "../system/deps";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

router.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

router.get("/ready", (_req, res) => {
  if (!deps.db.ready) {
    return res.status(503).json({ status: "degraded" });
  }

  return res.json({ status: "ready" });
});

router.get("/readyz", (_req, res) => {
  if (!deps.db.ready) {
    return res.status(503).json({ status: "degraded" });
  }

  return res.json({ status: "ready" });
});

export default router;
