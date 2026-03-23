import { Router } from "express";

const router = Router();

router.get("/ready", async (req: any, res: any) => {
  res.json({ status: "ready" });
});

export default router;
