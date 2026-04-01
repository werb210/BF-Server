import { Router } from "express";
import { fetchStatus } from "../startupState";
import { ok, fail } from "../middleware/response";
import { runQuery } from "../lib/db";

const router = Router();

async function healthResponse(res: Parameters<typeof ok>[0]) {
  try {
    await runQuery("SELECT 1");
    return ok(res, { db: "ok" });
  } catch {
    return fail(res, 503, "DB_UNAVAILABLE");
  }
}

router.get("/health", async (_req, res) => {
  return healthResponse(res);
});

router.get("/healthz", async (_req, res) => {
  return healthResponse(res);
});

router.get("/readyz", (_req, res) => {
  const status = fetchStatus();
  const ready = status.ready && !status.reason;
  if (!ready) {
    return fail(res, 503, "not_ready");
  }

  return ok(res, { ready, status });
});

export default router;
