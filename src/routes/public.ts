import { Router } from "express";
import rateLimit from "express-rate-limit";
import { fetchActiveLenderCount } from "../services/publicService";
import { createReadinessLead } from "../modules/readiness/readiness.service";
import { config } from "../config";

const router = Router();

router.get("/lender-count", async (_req: any, res: any) => {
  const count = await fetchActiveLenderCount();
  res.json({ count });
});

const readinessLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.env === "test",
});

router.post("/readiness", readinessLimiter, async (req: any, res: any) => {
  try {
    const { leadId } = await createReadinessLead(req.body ?? {});
    res.status(201).json({ leadId, status: "created" });
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_phone") {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    if (error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "ZodError") {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
