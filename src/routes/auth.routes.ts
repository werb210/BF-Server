import { Router } from "express";

const router = Router();

router.post("/otp/start", (req, res) => {
  res.json({ ok: true, data: { sent: true } });
});

router.post("/otp/verify", (req, res) => {
  res.setHeader("Set-Cookie", "token=dev-token; Path=/; HttpOnly");
  res.json({ ok: true, data: { token: "dev-token" } });
});

export default router;
