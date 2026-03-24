import { Router } from "express";
import { config } from "../../config";
import { registry } from "../../metrics/registry";

const router = Router();

router.get("/healthz", async (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/readyz", async (_req, res) => {
  if (!config.db.skip) {
    // optional DB check
  }

  res.json({ status: "ready" });
});

router.get("/metrics", async (_req, res) => {
  res.set("Content-Type", registry.contentType);
  res.send(await registry.metrics());
});

export default router;
