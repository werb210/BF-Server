import { Router } from "express";

const router = Router();

/**
 * GET CALL STATS
 */
router.get("/stats", (_req, res) => {
  return res.json({
    staff_1: {
      totalCalls: 25,
      answeredCalls: 20,
      missedCalls: 5,
      averageDuration: 180,
    },
  });
});

export default router;
