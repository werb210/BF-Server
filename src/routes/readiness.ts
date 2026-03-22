import { Router } from "express";

const router = Router();

router.get("/ready", async (req, res) => {
  res.json({ status: "ready" });
});

export default router;
