import { Router } from "express";

const router = Router();

router.get("/token", (_req, res) => {
  const token = "fake-telephony-token";
  res.status(200).json({ ok: true, token });
});

export default router;
