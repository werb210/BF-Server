import { Router, type Request } from "express";
import { AppError } from "../middleware/errors";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { recordAuditEvent } from "../modules/audit/audit.service";
import { logError } from "../observability/logger";
import { safeHandler } from "../middleware/safeHandler";
import {
  OPS_KILL_SWITCH_KEYS,
  type OpsKillSwitchKey,
  listKillSwitches,
  setKillSwitch,
} from "../modules/ops/ops.service";
import {
  createReplayJob,
  getReplayJobStatus,
  REPLAY_SCOPES,
  runReplayJob,
} from "../modules/ops/replay.service";
import { toStringSafe } from "../utils/toStringSafe";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));

function assertKillSwitchKey(key: string): asserts key is OpsKillSwitchKey {
  if (!OPS_KILL_SWITCH_KEYS.includes(key as OpsKillSwitchKey)) {
    throw new AppError("invalid_kill_switch", "Unsupported kill switch key.", 400);
  }
}

function getAuditContext(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

router.get("/kill-switches", safeHandler(async (req, res, next) => {
  const switches = await listKillSwitches();
  await recordAuditEvent({
    action: "ops_kill_switches_viewed",
    actorUserId: req.user?.userId ?? null,
    targetUserId: null,
    targetType: "ops",
    targetId: "kill_switches",
    ...getAuditContext(req),
    success: true,
  });
  res.json({ switches });
}));

router.post("/kill-switches/:key/enable", safeHandler(async (req, res, next) => {
  const key = toStringSafe(req.params.key) ?? "";
  assertKillSwitchKey(key);
  await setKillSwitch(key, true);
  await recordAuditEvent({
    action: "ops_kill_switch_enabled",
    actorUserId: req.user?.userId ?? null,
    targetUserId: null,
    targetType: "ops_kill_switch",
    targetId: key,
    ...getAuditContext(req),
    success: true,
  });
  res.json({ key, enabled: true });
}));

router.post("/kill-switches/:key/disable", safeHandler(async (req, res, next) => {
  const key = toStringSafe(req.params.key) ?? "";
  assertKillSwitchKey(key);
  await setKillSwitch(key, false);
  await recordAuditEvent({
    action: "ops_kill_switch_disabled",
    actorUserId: req.user?.userId ?? null,
    targetUserId: null,
    targetType: "ops_kill_switch",
    targetId: key,
    ...getAuditContext(req),
    success: true,
  });
  res.json({ key, enabled: false });
}));

router.post("/replay/:scope", safeHandler(async (req, res, next) => {
  const scope = toStringSafe(req.params.scope) ?? "";
  if (!REPLAY_SCOPES.includes(scope as (typeof REPLAY_SCOPES)[number])) {
    throw new AppError("invalid_scope", "Unsupported replay scope.", 400);
  }
  const job = await createReplayJob(scope);
  await recordAuditEvent({
    action: "ops_replay_started",
    actorUserId: req.user?.userId ?? null,
    targetUserId: null,
    targetType: "ops_replay",
    targetId: job.scope,
    ...getAuditContext(req),
    success: true,
  });
  setImmediate(() => {
    runReplayJob(job.id, job.scope).catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      logError("replay_failed", { code: "replay_failed", message });
    });
  });
  res.status(202).json({ job });
}));

router.get("/replay/:id/status", safeHandler(async (req, res, next) => {
  const jobId = toStringSafe(req.params.id);
  if (!jobId) {
    throw new AppError("validation_error", "Replay job id is required.", 400);
  }
  const job = await getReplayJobStatus(jobId);
  if (!job) {
    throw new AppError("not_found", "Replay job not found.", 404);
  }
  await recordAuditEvent({
    action: "ops_replay_status_viewed",
    actorUserId: req.user?.userId ?? null,
    targetUserId: null,
    targetType: "ops_replay",
    targetId: job.id,
    ...getAuditContext(req),
    success: true,
  });
  res.json({ job });
}));

export default router;
