// BF_NOTIFICATIONS_v50 — current-user notification inbox.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { listForUser, markAllRead, markRead, unreadCount } from "../services/notifications/notifications.service.js";

const router = Router();

function userIdOf(req: { user?: { id?: string | null; userId?: string | null } | null }): string {
  const id = req.user?.id ?? req.user?.userId ?? null;
  if (!id) throw new AppError("unauthorized", "Authentication required.", 401);
  return String(id);
}

router.get(
  "/",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const unreadOnly = String(req.query?.unread ?? "").toLowerCase() === "1" ||
                       String(req.query?.unread ?? "").toLowerCase() === "true";
    const limit = Number(req.query?.limit ?? 50);
    const items = await listForUser(userId, { unreadOnly, limit: Number.isFinite(limit) ? limit : 50 });
    const unread = await unreadCount(userId);
    res.status(200).json({ ok: true, items, unread_count: unread });
  })
);

router.post(
  "/:id/read",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError("validation_error", "id required.", 400);
    const ok = await markRead(userId, id);
    if (!ok) throw new AppError("not_found", "Notification not found or already read.", 404);
    res.status(200).json({ ok: true, id });
  })
);

router.post(
  "/read-all",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const userId = userIdOf(req);
    const count = await markAllRead(userId);
    res.status(200).json({ ok: true, count });
  })
);

export default router;
