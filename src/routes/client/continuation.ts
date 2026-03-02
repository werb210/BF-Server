import { Router, Request, Response } from "express";
import { verifyClientContinuationToken } from "../../services/auth/continuationTokenService";
import { getLatestIncompleteApplication } from "../../services/applications/applicationService";

const router = Router();

/**
 * GET /api/client/continuation/:token
 */
router.get("/continuation/:token", async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    const decoded = verifyClientContinuationToken(token);
    if (!decoded) {
      return res.status(401).json({ error: "Invalid token" });
    }

    const app = await getLatestIncompleteApplication(decoded.userId);

    if (!app) {
      return res.status(200).json({
        exists: false,
      });
    }

    return res.status(200).json({
      exists: true,
      application: app,
    });
  } catch (_err) {
    return res.status(401).json({ error: "Invalid token" });
  }
});

export default router;
