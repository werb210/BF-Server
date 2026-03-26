import { Router } from "express";

import { requireAuth } from "../middleware/requireAuth";

const router = Router();

router.get("/token", requireAuth, (_req, res) => {
  const token = "fake-telephony-token";
  return res.status(200).json({ token });
});

export default router;
