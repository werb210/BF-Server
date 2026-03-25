import { Router } from "express";

const router = Router();

router.get("/token", (_req, res) => {
  const token = "fake-telephony-token";
  res.status(200).json({ token });
});

export default router;
