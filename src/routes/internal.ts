import { Router, type Request } from "express";
import { pool } from "../db";
import { runtimeEnv } from "src/server/config/config";
import { listKillSwitches } from "../modules/ops/ops.service";
import { listActiveReplayJobs } from "../modules/ops/replay.service";
import { listRecentExports } from "../modules/exports/export.service";
import { createUserAccount } from "../modules/auth/auth.service";
import { ROLES } from "../auth/roles";
import { AppError } from "../middleware/errors";
import { logInfo, logWarn } from "../observability/logger";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { config } from "../config";

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

router.get("/version", (_req: any, res: any) => {
  const commitHash = runtimeEnv.commitSha;
  const buildTimestamp = runtimeEnv.buildTimestamp;
  res.json({ commitHash, buildTimestamp });
});

router.post("/bootstrap-admin", async (req: any, res: any, next: any) => {
  try {
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

    const countRes = await pool.query<{ count: number }>(
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

    res.status(201).json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/ops", async (_req, res, next) => {
  try {
    const switches = await listKillSwitches();
    res.json({ switches });
  } catch (err) {
    next(err);
  }
});

router.get("/jobs", async (_req, res, next) => {
  try {
    const jobs = await listActiveReplayJobs();
    res.json({ jobs });
  } catch (err) {
    next(err);
  }
});

router.get("/exports/recent", async (_req, res, next) => {
  try {
    const exports = await listRecentExports();
    res.json({ exports });
  } catch (err) {
    next(err);
  }
});

export default router;
