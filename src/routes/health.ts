import { Router } from "express";
import { dbHealth } from "../health/dbHealth";
import { fetchStatus } from "../startupState";
import { ok, fail } from "../middleware/response";
import { withTimeout } from "../utils/withTimeout";

const router = Router();

type HealthDbStatus = "ok" | "degraded";

async function getDbStatus(): Promise<HealthDbStatus> {
  try {
    const health = await withTimeout(dbHealth(), 150);
    return health.db === "ok" ? "ok" : "degraded";
  } catch {
    return "degraded";
  }
}

async function buildHealthPayload() {
  const dbStatus = await getDbStatus();

  return {
    server: "ok",
    twilio: process.env.TWILIO_VERIFY_SERVICE_SID ? "configured" : "missing",
    db: dbStatus,
    version: process.env.APP_VERSION ?? null,
    environment: process.env.NODE_ENV ?? "development",
  };
}

router.get("/health", async (_req, res) => {
  const payload = await buildHealthPayload();
  return ok(res, payload);
});

router.get("/healthz", async (_req, res) => {
  const payload = await buildHealthPayload();
  return ok(res, payload);
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
