import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.status(200).json({ ok: true });
});

router.post("/", (_req, res) => {
  res.status(200).json({ ok: true });
});

export default router;
