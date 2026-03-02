import { Router } from "express";

const router = Router();

router.get("/health", (_req, res) => {
  return res.status(200).json({ ok: true });
});

export default router;
