import { Router } from "express";

const router = Router();

/**
 * Client application continuation endpoint.
 * Returns a placeholder response so the
 * client step flow can load in development.
 */
router.get("/continuation", async (_req: any, res: any) => {
  res.json({
    status: "ok",
    data: {},
  });
});

export default router;
