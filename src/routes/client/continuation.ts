import { Router, Request, Response } from "express";
import { getContinuation as getClientContinuation } from "../../modules/continuation/continuation.service";

const router = Router();

/**
 * GET /client/continuation/:token
 */
router.get("/:token", async (req: Request, res: Response) => {
  const token = req.params.token;

  if (typeof token !== "string") {
    return res.status(400).json({
      error: "token is required",
    });
  }

  try {
    const result = await getClientContinuation(token);

    if (!result) {
      return res.status(404).json({
        error: "Application not found",
      });
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error("Continuation route error:", error);
    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;
