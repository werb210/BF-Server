import { Router } from "express";
import { isReady } from "../startupState";

const router = Router();

router.get('/health/db', (req, res) => {
  const ready = isReady();

  if (!ready) {
    return res.status(503).json({
      status: 'db-failed',
    });
  }

  return res.status(200).json({
    status: 'ok',
  });
});

export default router;
