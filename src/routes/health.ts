import { Router } from "express";

const router = Router();

/**
 * MUST remain:
 * - synchronous
 * - dependency-free
 * - zero middleware reliance
 */
router.get("/", (_req, res) => {
  res.status(200).send("ok");
});

export default router;
