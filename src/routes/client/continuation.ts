import { Router } from "express";
import { getContinuation as getClientContinuation } from "../../modules/continuation/continuation.service";

const router = Router();

/**
 * GET /api/client/continuation/:token
 */
router.get("/continuation/:token", async (req: any, res: any, next: any) => {
  const token = req.params.token;

  if (!token) {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const result = await getClientContinuation(token);

    if (!result) {
      return res.status(401).json({ error: "Invalid token" });
    }

    return res.status(200).json({ exists: true, application: result });
  } catch (err) {
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;
