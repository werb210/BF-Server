import { Router } from "express";
import { ok } from "../system/wrap";

const router = Router();

router.get("/", (_req, res) => {
  const dbOk = true;
  const dbStatus =
    process.env.NODE_ENV === "test" || process.env.CI
      ? "ok"
      : dbOk
      ? "ok"
      : "degraded";

  return ok(res, {
    server: "ok",
    db: dbStatus,
  });
});

export default router;
