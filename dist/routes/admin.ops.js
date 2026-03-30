"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../middleware/errors");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const audit_service_1 = require("../modules/audit/audit.service");
const logger_1 = require("../observability/logger");
const safeHandler_1 = require("../middleware/safeHandler");
const ops_service_1 = require("../modules/ops/ops.service");
const replay_service_1 = require("../modules/ops/replay.service");
const toStringSafe_1 = require("../utils/toStringSafe");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.OPS_MANAGE]));
function assertKillSwitchKey(key) {
    if (!ops_service_1.OPS_KILL_SWITCH_KEYS.includes(key)) {
        throw new errors_1.AppError("invalid_kill_switch", "Unsupported kill switch key.", 400);
    }
}
function fetchAuditContext(req) {
    return {
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    };
}
router.get("/kill-switches", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const switches = await (0, ops_service_1.listKillSwitches)();
    await (0, audit_service_1.recordAuditEvent)({
        action: "ops_kill_switches_viewed",
        actorUserId: req.user?.userId ?? null,
        targetUserId: null,
        targetType: "ops",
        targetId: "kill_switches",
        ...fetchAuditContext(req),
        success: true,
    });
    res["json"]({ switches });
}));
router.post("/kill-switches/:key/enable", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const key = (0, toStringSafe_1.toStringSafe)(req.params.key) ?? "";
    assertKillSwitchKey(key);
    await (0, ops_service_1.setKillSwitch)(key, true);
    await (0, audit_service_1.recordAuditEvent)({
        action: "ops_kill_switch_enabled",
        actorUserId: req.user?.userId ?? null,
        targetUserId: null,
        targetType: "ops_kill_switch",
        targetId: key,
        ...fetchAuditContext(req),
        success: true,
    });
    res["json"]({ key, enabled: true });
}));
router.post("/kill-switches/:key/disable", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const key = (0, toStringSafe_1.toStringSafe)(req.params.key) ?? "";
    assertKillSwitchKey(key);
    await (0, ops_service_1.setKillSwitch)(key, false);
    await (0, audit_service_1.recordAuditEvent)({
        action: "ops_kill_switch_disabled",
        actorUserId: req.user?.userId ?? null,
        targetUserId: null,
        targetType: "ops_kill_switch",
        targetId: key,
        ...fetchAuditContext(req),
        success: true,
    });
    res["json"]({ key, enabled: false });
}));
router.post("/replay/:scope", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const scope = (0, toStringSafe_1.toStringSafe)(req.params.scope) ?? "";
    if (!replay_service_1.REPLAY_SCOPES.includes(scope)) {
        throw new errors_1.AppError("invalid_scope", "Unsupported replay scope.", 400);
    }
    const job = await (0, replay_service_1.createReplayJob)(scope);
    await (0, audit_service_1.recordAuditEvent)({
        action: "ops_replay_started",
        actorUserId: req.user?.userId ?? null,
        targetUserId: null,
        targetType: "ops_replay",
        targetId: job.scope,
        ...fetchAuditContext(req),
        success: true,
    });
    setImmediate(() => {
        (0, replay_service_1.runReplayJob)(job.id, job.scope).catch((error) => {
            const message = error instanceof Error ? error.message : "unknown error";
            (0, logger_1.logError)("replay_failed", { code: "replay_failed", message });
        });
    });
    res.status(202).json({ job });
}));
router.get("/replay/:id/status", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const jobId = (0, toStringSafe_1.toStringSafe)(req.params.id);
    if (!jobId) {
        throw new errors_1.AppError("validation_error", "Replay job id is required.", 400);
    }
    const job = await (0, replay_service_1.fetchReplayJobStatus)(jobId);
    if (!job) {
        throw new errors_1.AppError("not_found", "Replay job not found.", 404);
    }
    await (0, audit_service_1.recordAuditEvent)({
        action: "ops_replay_status_viewed",
        actorUserId: req.user?.userId ?? null,
        targetUserId: null,
        targetType: "ops_replay",
        targetId: job.id,
        ...fetchAuditContext(req),
        success: true,
    });
    res["json"]({ job });
}));
exports.default = router;
