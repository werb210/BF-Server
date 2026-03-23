import express from "express";

const router = express.Router();

// REQUIRED BY PORTAL
router.get("/token", async (_req: any, res: any) => {
  res.json({ token: "dev-token" });
});

router.get("/presence", async (_req: any, res: any) => {
  res.json({ status: "available" });
});

router.get("/call-status", async (_req: any, res: any) => {
  res.json({ calls: [] });
});

router.post("/outbound-call", async (_req: any, res: any) => {
  res.json({ success: true });
});

router.post("/call-status", async (_req: any, res: any) => {
  res.json({ updated: true });
});

export default router;
