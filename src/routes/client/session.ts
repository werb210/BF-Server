import { Router } from "express";

const router = Router();

router.post("/session/refresh", (_req, res) => {
  res.status(200).json({ session: null });
});

export default router;
