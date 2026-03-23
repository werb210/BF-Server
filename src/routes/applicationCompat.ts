import { Router } from "express";

const router = Router();

router.post("/api/application", async (req: any, res: any, next: any) => {
  const data = req.body;

  return res.json({
    success: true,
    data,
  });
});

router.post("/api/application/update", async (_req, res) => {
  return res.json({ success: true });
});

router.post("/api/application/continuation", async (_req, res) => {
  return res.json({ success: true });
});

router.post("/api/readiness/submit", async (_req, res) => {
  return res.json({
    success: true,
    status: "submitted",
  });
});

export default router;
