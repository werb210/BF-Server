import { Router } from "express";
import { config } from "../../config";

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

export default router;
