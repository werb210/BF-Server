import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "bf-server",
    timestamp: new Date().toISOString(),
  });
});

router.get("/dev/ping", (_req, res) => {
  res.json({
    message: "pong",
  });
});

export default router;
