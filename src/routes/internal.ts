import { Router, type Request } from "express";
import { pool, runQuery } from "../db";
import { config } from "../config";
import { listKillSwitches } from "../modules/ops/ops.service";
import { listActiveReplayJobs } from "../modules/ops/replay.service";
import { listRecentExports } from "../modules/exports/export.service";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { AppError } from "../middleware/errors";
import { logInfo, logWarn } from "../observability/logger";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { ok } from "../lib/apiResponse";
import { wrap } from "../lib/routeWrap";

const router = Router();
let bootstrapAdminDisabled = false;

function buildRequestMetadata(req: Request): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (req.ip) {
    metadata.ip = req.ip;
  }
  const userAgent = req.get("user-agent");
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  return metadata;
}

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));

router.get("/version", wrap(async () => {
  const commitHash = config.commitSha;
  const buildTimestamp = config.buildTimestamp;
  return ok({ commitHash, buildTimestamp });
}));

router.post("/bootstrap-admin", wrap(async (req: any) => {
    logInfo("bootstrap_admin_attempt", {
      disabled: bootstrapAdminDisabled,
    });

    if (bootstrapAdminDisabled) {
      throw new AppError(
        "bootstrap_disabled",
        "Bootstrap has already been used.",
        410
      );
    }

    const phoneNumber = config.bootstrap.adminPhone;
    if (!phoneNumber) {
      throw new AppError(
        "bootstrap_missing_phone",
        "BOOTSTRAP_ADMIN_PHONE is required.",
        500
      );
    }

    const countRes = await runQuery<{ count: number }>(
      "select count(*)::int as count from users where role = $1",
      [ROLES.ADMIN]
    );
    const adminCount = countRes.rows[0]?.count ?? 0;
    logInfo("bootstrap_admin_count", { adminCount });

    if (adminCount > 0) {
      logWarn("bootstrap_admin_blocked", { reason: "admin_exists" });
      throw new AppError(
        "bootstrap_disabled",
        "Admin user already exists.",
        409
      );
    }

    const user = await createUserAccount({
      email: "todd.w@boreal.financial",
      phoneNumber,
      role: ROLES.ADMIN,
      actorUserId: null,
      ...buildRequestMetadata(req),
    });

    bootstrapAdminDisabled = true;
    logInfo("bootstrap_admin_success", {
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    return ok({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
}));

router.get("/ops", wrap(async () => {
  const switches = await listKillSwitches();
  return ok({ switches });
}));

router.get("/jobs", wrap(async () => {
  const jobs = await listActiveReplayJobs();
  return ok({ jobs });
}));

router.get("/exports/recent", wrap(async () => {
  const exports = await listRecentExports();
  return ok({ exports });
}));

router.get("/failed-jobs", wrap(async () => {
    const result = await runQuery(
      `SELECT id, type, error, retry_count, created_at
       FROM failed_jobs
       ORDER BY created_at DESC
       LIMIT 100`
    );

    return ok(result.rows);
}));

export default router;
