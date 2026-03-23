import { Router } from "express";
import { z } from "zod";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { safeHandler } from "../middleware/safeHandler";
import {
  listPwaNotificationsForUser,
  listPwaSubscriptions,
  upsertPwaSubscription,
  deletePwaSubscription,
  acknowledgePwaNotification,
  deletePwaSubscriptionLegacy,
} from "../repositories/pwa.repo";
import { AppError } from "../middleware/errors";
import { config } from "../config";
import { fetchPushStatus } from "../services/pushService";
import { replaySyncBatch } from "../services/pwaSyncService";
import { pool } from "../db";
import { ALL_ROLES, ROLES } from "../auth/roles";
import { toStringSafe } from "../utils/toStringSafe";

const router = Router();
const DEFAULT_NOTIFICATION_LIMIT = 50;
const MAX_NOTIFICATION_LIMIT = 100;

const perUserNotificationReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId ?? ipKeyGenerator(req.ip ?? ""),
  skip: () => config.env === "test" || config.rateLimit.enabled === "false",
});

const perUserNotificationAckLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId ?? ipKeyGenerator(req.ip ?? ""),
  skip: () => config.env === "test" || config.rateLimit.enabled === "false",
});

const subscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  deviceType: z.enum(["mobile", "desktop"]),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1),
  scope: z.enum(["legacy", "owned"]).optional(),
});

router.post(
  "/subscribe",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(async (req: any, res: any, next: any) => {
    const requestId = res.locals.requestId ?? "unknown";
    const parsedResult = subscriptionSchema.safeParse(req.body ?? {});
    if (!parsedResult.success) {
      throw new AppError("validation_error", "Invalid subscription payload.", 400);
    }
    const parsed = parsedResult.data;
    const subscription = await upsertPwaSubscription({
      userId: req.user!.userId,
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
  })
);

router.delete(
  "/unsubscribe",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(async (req: any, res: any, next: any) => {
    const parsedResult = unsubscribeSchema.safeParse(req.body ?? {});
    if (!parsedResult.success) {
      throw new AppError("validation_error", "Invalid unsubscribe payload.", 400);
    }
    const parsed = parsedResult.data;
    const endpoint = parsed.endpoint.trim();
    const scope = parsed.scope ?? "owned";
    const removed =
      scope === "legacy"
        ? await deletePwaSubscriptionLegacy(endpoint)
        : await deletePwaSubscription({
            userId: req.user!.userId,
            endpoint,
          });
    res.status(200).json({ ok: true, removed, scope });
  })
);

router.delete(
  "/unsubscribe/owned",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(async (req: any, res: any, next: any) => {
    const parsedResult = unsubscribeSchema.safeParse(req.body ?? {});
    if (!parsedResult.success) {
      throw new AppError("validation_error", "Invalid unsubscribe payload.", 400);
    }
    const parsed = parsedResult.data;
    const removed = await deletePwaSubscription({
      userId: req.user!.userId,
      endpoint: parsed.endpoint.trim(),
    });
    res.status(200).json({ ok: true, removed, scope: "owned" });
  })
);

router.get(
  "/subscriptions",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (_req: any, res: any) => {
    const subscriptions = await listPwaSubscriptions();
    res.status(200).json({ ok: true, subscriptions });
  })
);

router.get(
  "/notifications",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  perUserNotificationReadLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    const limitRaw = typeof toStringSafe(req.query.limit) === "string" ? Number(toStringSafe(req.query.limit)) : DEFAULT_NOTIFICATION_LIMIT;
    const offsetRaw = typeof toStringSafe(req.query.offset) === "string" ? Number(toStringSafe(req.query.offset)) : 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(MAX_NOTIFICATION_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : DEFAULT_NOTIFICATION_LIMIT;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

    const result = await listPwaNotificationsForUser({
      userId: req.user!.userId,
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
  })
);

router.post(
  "/notifications/:id/ack",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  perUserNotificationAckLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    const id = toStringSafe(req.params.id);
    if (!id) {
      throw new AppError("validation_error", "id is required.", 400);
    }
    const updated = await acknowledgePwaNotification({
      userId: req.user!.userId,
      notificationId: id,
    });
    res.status(200).json({ ok: true, acknowledged: updated });
  })
);

router.post(
  "/sync",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(async (req: any, res: any, next: any) => {
    const requestId = res.locals.requestId ?? "unknown";
    const user = req.user!;
    const replayUser = {
      userId: user.userId,
      role: user.role,
      capabilities: user.capabilities ?? [],
      ...(user.lenderId !== undefined ? { lenderId: user.lenderId } : {}),
    };
    const result = await replaySyncBatch({
      user: replayUser,
      payload: req.body ?? {},
      requestId,
    });
    res.status(200).json({
      ok: true,
      batchId: result.batchId,
      results: result.results,
    });
  })
);

router.get(
  "/runtime",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(async (_req: any, res: any) => {
    const commitHash = config.commitSha;
    const buildTimestamp = config.buildTimestamp;
    const pushStatus = fetchPushStatus();
    res.status(200).json({
      push_enabled: pushStatus.enabled,
      background_sync_enabled: true,
      vapid_configured: pushStatus.configured,
      vapid_subject: pushStatus.subject ?? null,
      vapid_error: pushStatus.error ?? null,
      offline_replay_enabled: true,
      server_version: commitHash ?? buildTimestamp ?? "unknown",
    });
  })
);

router.get(
  "/health",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (_req: any, res: any) => {
    const pushStatus = fetchPushStatus();
    let dbWriteable = false;
    let queueProcessingHealthy: boolean | null = null;
    const warnings: string[] = [];

    try {
      await pool.query("create temporary table if not exists pwa_health_check (id int)");
      await pool.query("insert into pwa_health_check (id) values (1)");
      dbWriteable = true;
    } catch {
      dbWriteable = false;
      warnings.push("db_write_failed");
    }

    try {
      const tableCheck = await pool.query<{ exists: string | null }>(
        "select to_regclass('public.ops_replay_jobs') as exists"
      );
      if (!tableCheck.rows[0]?.exists) {
        queueProcessingHealthy = null;
        warnings.push("queue_table_missing");
      } else {
        const result = await pool.query<{ count: number }>(
          `select count(*)::int as count
           from ops_replay_jobs
           where status in ('queued', 'running')
             and started_at is not null
             and started_at < (now()::timestamp - interval '15 minutes')`
        );
        queueProcessingHealthy = result.rows[0]?.count === 0;
      }
    } catch {
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
  })
);

export default router;
