import { Router } from "express";
import { dbHealth } from "../health/dbHealth";
import { fetchStatus } from "../startupState";
import { ok, fail } from "../middleware/response";

const router = Router();

async function buildHealthPayload() {
  const health = await dbHealth();
  return {
    api: "ok",
    timestamp: Date.now(),
    ...health,
  };
}

router.get("/health", async (_req, res) => {
  if (!process.env.TWILIO_VERIFY_SERVICE_SID) {
    return fail(res, 500, "verify_missing");
  }

  const payload = await buildHealthPayload();
  if (payload.db !== "ok") {
    return fail(res, 503, "db_unhealthy");
  }

  return ok(res, payload);
});

router.get("/healthz", async (_req, res) => {
  if (!process.env.TWILIO_VERIFY_SERVICE_SID) {
    return fail(res, 500, "verify_missing");
  }

  const payload = await buildHealthPayload();
  if (payload.db !== "ok") {
    return fail(res, 503, "db_unhealthy");
  }

  return ok(res, payload);
});

router.get("/readyz", (_req, res) => {
  const status = fetchStatus();
  const ready = status.ready && !status.reason;
  return res.status(ready ? 200 : 503).json({ ready, status });
});

export default router;
