import { Router } from "express";

const router = Router();

router.post("/otp/start", (_req, res) => {
  res.json({
    ok: true,
    data: { sent: true },
  });
});

router.post("/otp/verify", (_req, res) => {
  res.json({
    ok: true,
    data: { token: "dev-token" },
  });
});

export default router;
