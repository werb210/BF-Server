import { Router } from "express";

const router = Router();

router.get("/", (req, res) => {
  const deps = req.app.locals.deps;

  // hard guard
  if (!deps || !deps.db) {
    return res.status(503).json({ status: "not_ready" });
  }

  // CRITICAL: read LIVE value every request
  if (deps.db.ready !== true) {
    return res.status(503).json({ status: "not_ready" });
  }

  return res.status(200).json({ status: "ok" });
});

export default router;
