import { Router } from "express";

const router = Router();

router.get("/", (_req, res) => {
  res.json({
    ok: true,
  });
});

router.get("/pipeline", async (req, res) => {
  res.json({ ok: true, data: [] });
});

router.get("/actions", async (req, res) => {
  res.json({ ok: true, data: [] });
});

router.get("/metrics", async (req, res) => {
  res.json({ ok: true, data: {} });
});

router.get("/offers", async (req, res) => {
  res.json({ ok: true, data: [] });
});

router.get("/document-health", async (req, res) => {
  res.json({ ok: true, data: {} });
});

router.get("/lender-activity", async (req, res) => {
  res.json({ ok: true, data: [] });
});

export default router;
