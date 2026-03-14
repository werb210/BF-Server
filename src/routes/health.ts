import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "bf-server",
    timestamp: new Date().toISOString(),
  });
});

router.get("/health/db", (_req, res) => {
  res.status(200).json({
    status: "db-ok",
  });
});

export default router;
