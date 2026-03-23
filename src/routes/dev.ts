import { Router } from "express";

const router = Router();

router.get("/health", (_req: any, res: any) => {
  res.json({
    status: "ok",
    service: "bf-server",
    timestamp: new Date().toISOString(),
  });
});

router.get("/dev/ping", (_req: any, res: any) => {
  res.json({
    message: "pong",
  });
});

export default router;
