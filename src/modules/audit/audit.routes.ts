import { Router } from "express";
import { AppError } from "../../middleware/errors";
import { listAuditEvents } from "./audit.repo";
import { recordAuditEvent } from "./audit.service";

const router = Router();

router.get("/events", async (req: any, res: any, next: any) => {
  try {
    const { actorUserId, targetUserId, action, from, to, limit, offset } =
      req.query ?? {};
    const parsedLimit = Math.min(
      200,
      Math.max(1, Number(limit ?? 50) || 50)
    );
    const parsedOffset = Math.max(0, Number(offset ?? 0) || 0);
    const fromDate = typeof from === "string" ? new Date(from) : null;
    const toDate = typeof to === "string" ? new Date(to) : null;
    if (fromDate && Number.isNaN(fromDate.getTime())) {
      throw new AppError("invalid_range", "Invalid from timestamp.", 400);
    }
    if (toDate && Number.isNaN(toDate.getTime())) {
      throw new AppError("invalid_range", "Invalid to timestamp.", 400);
    }

    const events = await listAuditEvents({
      actorUserId: typeof actorUserId === "string" ? actorUserId : null,
      targetUserId: typeof targetUserId === "string" ? targetUserId : null,
      action: typeof action === "string" ? action : null,
      from: fromDate,
      to: toDate,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    await recordAuditEvent({
      action: "audit_view",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      success: true,
    });

    res.json({ events, limit: parsedLimit, offset: parsedOffset });
  } catch (err) {
    next(err);
  }
});

export default router;
