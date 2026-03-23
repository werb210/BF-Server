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
import { runtimeEnv } from "src/server/config/config";
import { getPushStatus } from "../services/pushService";
import { replaySyncBatch } from "../services/pwaSyncService";
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
  skip: () => process.env.NODE_ENV === "test" || process.env.RATE_LIMIT_ENABLED === "false",
});

const perUserNotificationAckLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId ?? ipKeyGenerator(req.ip ?? ""),
  skip: () => process.env.NODE_ENV === "test" || process.env.RATE_LIMIT_ENABLED === "false",
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
    const commitHash = runtimeEnv.commitSha;
    const buildTimestamp = runtimeEnv.buildTimestamp;
    const pushStatus = getPushStatus();
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

export default router;
