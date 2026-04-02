import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  return res.status(200).json({ status: "ok" });
});

export default router;
