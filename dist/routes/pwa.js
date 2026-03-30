"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const express_rate_limit_1 = __importStar(require("express-rate-limit"));
const auth_1 = require("../middleware/auth");
const safeHandler_1 = require("../middleware/safeHandler");
const pwa_repo_1 = require("../repositories/pwa.repo");
const errors_1 = require("../middleware/errors");
const config_1 = require("../config");
const pushService_1 = require("../services/pushService");
const pwaSyncService_1 = require("../services/pwaSyncService");
const db_1 = require("../db");
const roles_1 = require("../auth/roles");
const toStringSafe_1 = require("../utils/toStringSafe");
const router = (0, express_1.Router)();
const DEFAULT_NOTIFICATION_LIMIT = 50;
const MAX_NOTIFICATION_LIMIT = 100;
const perUserNotificationReadLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.userId ?? (0, express_rate_limit_1.ipKeyGenerator)(req.ip ?? ""),
    skip: () => config_1.config.env === "test" || config_1.config.rateLimit.enabled === "false",
});
const perUserNotificationAckLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.userId ?? (0, express_rate_limit_1.ipKeyGenerator)(req.ip ?? ""),
    skip: () => config_1.config.env === "test" || config_1.config.rateLimit.enabled === "false",
});
const subscriptionSchema = zod_1.z.object({
    endpoint: zod_1.z.string().min(1),
    keys: zod_1.z.object({
        p256dh: zod_1.z.string().min(1),
        auth: zod_1.z.string().min(1),
    }),
    deviceType: zod_1.z.enum(["mobile", "desktop"]),
});
const unsubscribeSchema = zod_1.z.object({
    endpoint: zod_1.z.string().min(1),
    scope: zod_1.z.enum(["legacy", "owned"]).optional(),
});
router.post("/subscribe", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const requestId = res.locals.requestId ?? "unknown";
    const parsedResult = subscriptionSchema.safeParse(req.body ?? {});
    if (!parsedResult.success) {
        throw new errors_1.AppError("validation_error", "Invalid subscription payload.", 400);
    }
    const parsed = parsedResult.data;
    const subscription = await (0, pwa_repo_1.upsertPwaSubscription)({
        userId: req.user.userId,
        endpoint: parsed.endpoint.trim(),
        p256dh: parsed.keys.p256dh,
        auth: parsed.keys.auth,
        deviceType: parsed.deviceType,
    });
    res.status(201).json({
        ok: true,
        requestId,
        subscription,
    });
}));
router.delete("/unsubscribe", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const parsedResult = unsubscribeSchema.safeParse(req.body ?? {});
    if (!parsedResult.success) {
        throw new errors_1.AppError("validation_error", "Invalid unsubscribe payload.", 400);
    }
    const parsed = parsedResult.data;
    const endpoint = parsed.endpoint.trim();
    const scope = parsed.scope ?? "owned";
    const removed = scope === "legacy"
        ? await (0, pwa_repo_1.deletePwaSubscriptionLegacy)(endpoint)
        : await (0, pwa_repo_1.deletePwaSubscription)({
            userId: req.user.userId,
            endpoint,
        });
    res.status(200).json({ ok: true, removed, scope });
}));
router.delete("/unsubscribe/owned", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const parsedResult = unsubscribeSchema.safeParse(req.body ?? {});
    if (!parsedResult.success) {
        throw new errors_1.AppError("validation_error", "Invalid unsubscribe payload.", 400);
    }
    const parsed = parsedResult.data;
    const removed = await (0, pwa_repo_1.deletePwaSubscription)({
        userId: req.user.userId,
        endpoint: parsed.endpoint.trim(),
    });
    res.status(200).json({ ok: true, removed, scope: "owned" });
}));
router.get("/subscriptions", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const subscriptions = await (0, pwa_repo_1.listPwaSubscriptions)();
    res.status(200).json({ ok: true, subscriptions });
}));
router.get("/notifications", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), perUserNotificationReadLimiter, (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const limitRaw = typeof (0, toStringSafe_1.toStringSafe)(req.query.limit) === "string" ? Number((0, toStringSafe_1.toStringSafe)(req.query.limit)) : DEFAULT_NOTIFICATION_LIMIT;
    const offsetRaw = typeof (0, toStringSafe_1.toStringSafe)(req.query.offset) === "string" ? Number((0, toStringSafe_1.toStringSafe)(req.query.offset)) : 0;
    const limit = Number.isFinite(limitRaw)
        ? Math.min(MAX_NOTIFICATION_LIMIT, Math.max(1, Math.floor(limitRaw)))
        : DEFAULT_NOTIFICATION_LIMIT;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
    const result = await (0, pwa_repo_1.listPwaNotificationsForUser)({
        userId: req.user.userId,
        limit,
        offset,
    });
    res.status(200).json({
        ok: true,
        notifications: result.notifications,
        pagination: {
            total: result.total,
            limit,
            offset,
            hasMore: offset + result.notifications.length < result.total,
        },
    });
}));
router.post("/notifications/:id/ack", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), perUserNotificationAckLimiter, (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const id = (0, toStringSafe_1.toStringSafe)(req.params.id);
    if (!id) {
        throw new errors_1.AppError("validation_error", "id is required.", 400);
    }
    const updated = await (0, pwa_repo_1.acknowledgePwaNotification)({
        userId: req.user.userId,
        notificationId: id,
    });
    res.status(200).json({ ok: true, acknowledged: updated });
}));
router.post("/sync", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const requestId = res.locals.requestId ?? "unknown";
    const user = req.user;
    const replayUser = {
        userId: user.userId,
        role: user.role,
        capabilities: user.capabilities ?? [],
        ...(user.lenderId !== undefined ? { lenderId: user.lenderId } : {}),
    };
    const result = await (0, pwaSyncService_1.replaySyncBatch)({
        user: replayUser,
        payload: req.body ?? {},
        requestId,
    });
    res.status(200).json({
        ok: true,
        batchId: result.batchId,
        results: result.results,
    });
}));
router.get("/runtime", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: roles_1.ALL_ROLES }), (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const commitHash = config_1.config.commitSha;
    const buildTimestamp = config_1.config.buildTimestamp;
    const pushStatus = (0, pushService_1.fetchPushStatus)();
    res.status(200).json({
        push_enabled: pushStatus.enabled,
        background_sync_enabled: true,
        vapid_configured: pushStatus.configured,
        vapid_subject: pushStatus.subject ?? null,
        vapid_error: pushStatus.error ?? null,
        offline_replay_enabled: true,
        server_version: commitHash ?? buildTimestamp ?? "unknown",
    });
}));
router.get("/health", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const pushStatus = (0, pushService_1.fetchPushStatus)();
    let dbWriteable = false;
    let queueProcessingHealthy = null;
    const warnings = [];
    try {
        await db_1.pool.query("create temporary table if not exists pwa_health_check (id int)");
        await db_1.pool.query("insert into pwa_health_check (id) values (1)");
        dbWriteable = true;
    }
    catch {
        dbWriteable = false;
        warnings.push("db_write_failed");
    }
    try {
        const tableCheck = await db_1.pool.query("select to_regclass('public.ops_replay_jobs') as exists");
        if (!tableCheck.rows[0]?.exists) {
            queueProcessingHealthy = null;
            warnings.push("queue_table_missing");
        }
        else {
            const result = await db_1.pool.query(`select count(*)::int as count
           from ops_replay_jobs
           where status in ('queued', 'running')
             and started_at is not null
             and started_at < (now()::timestamp - interval '15 minutes')`);
            queueProcessingHealthy = result.rows[0]?.count === 0;
        }
    }
    catch {
        queueProcessingHealthy = false;
        warnings.push("queue_check_failed");
    }
    res.status(200).json({
        ok: true,
        push_readiness: {
            enabled: pushStatus.enabled,
            configured: pushStatus.configured,
            error: pushStatus.error ?? null,
        },
        db_writeable: dbWriteable,
        queue_processing_healthy: queueProcessingHealthy,
        warnings,
    });
}));
exports.default = router;
