import { Router } from "express";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({
    status: "ready",
    activeCalls: 0,
    queueDepth: 0,
  });
});

export default router;
