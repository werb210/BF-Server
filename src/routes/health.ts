import { Router } from "express";

const router = Router();

router.get('/health/db', (req, res) => {
  const ready = req.app.locals.dbReady === true;

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
