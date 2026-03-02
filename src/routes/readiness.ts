import { Router } from "express";

const router = Router();

/**
 * POST /api/readiness
 */
router.post("/", async (req, res) => {
  const { applicationId } = req.body;

  if (!applicationId) {
    return res.status(400).json({ error: "Missing applicationId" });
  }

  return res.status(200).json({ ok: true });
});

/**
 * POST /api/readiness/continue
 */
router.post("/continue", async (req, res) => {
  return res.status(200).json({
    ok: true,
    session: {},
  });
});

export default router;
