import { Router } from "express";

const router = Router();

router.get("/api/dev/ready", async (_req, res) => {
  res.json({
    ok: true,
    service: "bf-server",
    mode: "development",
  });
});

router.get("/api/telephony/token", async (_req, res) => {
  res.json({
    token: "dev-token",
    identity: "dev-user",
  });
});

router.get("/api/application/continuation", async (_req, res) => {
  res.json({
    status: "ok",
    data: {},
  });
});

router.post("/api/application/update", async (_req, res) => {
  res.json({
    status: "ok",
    saved: true,
  });
});

export default router;
