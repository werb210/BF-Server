import { Router } from "express";

const router = Router();

router.get("/api/dev/ready", async (_req: any, res: any) => {
  res.json({
    ok: true,
    service: "bf-server",
    mode: "development",
  });
});

router.get("/telephony/token", async (_req: any, res: any) => {
  res.json({
    ok: true,
    token: "dev-token",
    identity: "dev-user",
  });
});

router.get("/api/application/continuation", async (_req: any, res: any) => {
  res.json({
    status: "ok",
    data: {},
  });
});

router.post("/api/application/update", async (_req: any, res: any) => {
  res.json({
    status: "ok",
    saved: true,
  });
});

export default router;
