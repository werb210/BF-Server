import { Router, type Request } from "express";
import { pool, runQuery } from "../db.js";
import { config } from "../config/index.js";
import { listKillSwitches } from "../modules/ops/ops.service.js";
import { listActiveReplayJobs } from "../modules/ops/replay.service.js";
import { listRecentExports } from "../modules/exports/export.service.js";
import { createUserAccount } from "../modules/auth/auth.service.js";
import { ROLES } from "../auth/roles.js";
import { AppError } from "../middleware/errors.js";
import { logInfo, logWarn } from "../observability/logger.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { ok } from "../lib/apiResponse.js";
import { wrap } from "../lib/routeWrap.js";

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

// BF_SERVER_JOB_QUEUE_VISIBILITY_v1
// job_queue drives lender package dispatch and nothing read it: /jobs returns
// replay jobs and /failed-jobs reads the failed_jobs table. Diagnosing a
// stalled dispatch meant opening psql.
router.get("/job-queue", wrap(async () => {
  const summary = await runQuery(
    `SELECT type, status, COUNT(*)::text AS count,
            MIN(created_at) AS oldest,
            MAX(updated_at) AS last_touched,
            MAX(COALESCE(attempts, 0))::text AS max_attempts
       FROM job_queue
      GROUP BY type, status
      ORDER BY COUNT(*) DESC`
  );

  // A pending row whose next_attempt_at has passed is claimable right now.
  // A large number here alongside an old "oldest" is a stalled queue.
  const claimable = await runQuery(
    `SELECT type, COUNT(*)::text AS count
       FROM job_queue
      WHERE status = 'pending'
        AND COALESCE(next_attempt_at, created_at) <= now()
      GROUP BY type ORDER BY COUNT(*) DESC`
  );

  const stuck = await runQuery(
    `SELECT id, type, status, error, COALESCE(attempts, 0)::text AS attempts,
            created_at, next_attempt_at, payload
       FROM job_queue
      WHERE status IN ('pending', 'running')
        AND created_at < now() - interval '1 hour'
      ORDER BY created_at ASC
      LIMIT 50`
  );

  return ok({
    summary: summary.rows,
    claimableNow: claimable.rows,
    stuckOverAnHour: stuck.rows,
  });
}));

export default router;
