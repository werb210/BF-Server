import { Router } from "express";
import { getContinuation as getClientContinuation } from "../../modules/continuation/continuation.service";

const router = Router();

/**
 * GET /api/client/continuation/:token
 */
router.get("/:token", async (req, res) => {
  const token = req.params.token;

  if (!token) {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const result = await getClientContinuation(token);

    if (!result) {
      return res.status(404).json({ exists: false });
    }

    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
