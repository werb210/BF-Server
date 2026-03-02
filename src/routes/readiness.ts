import { Router } from "express";

const router = Router();

/**
 * POST /api/readiness
 */
router.post("/readiness", (req, res) => {
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Invalid input" });
  }

  return res.status(200).json({
    ok: true,
  });
});

/**
 * POST /api/readiness/continue
 */
router.post("/readiness/continue", (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId" });
  }

  return res.status(200).json({
    ok: true,
    sessionId,
  });
});

export default router;
