import { Router } from "express";

const router = Router();

router.get("/health", (_req: any, res: any) => {
  res.status(200).json({
    status: "ok",
    service: "bf-server",
    timestamp: new Date().toISOString(),
  });
});

router.get("/health/db", (_req: any, res: any) => {
  res.status(200).json({
    status: "db-ok",
  });
});

router.get("/ready", (_req: any, res: any) => {
  res.status(200).json({
    ready: true,
  });
});

// Backward compatible endpoint.
router.get("/system/health", (_req: any, res: any) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

export default router;
