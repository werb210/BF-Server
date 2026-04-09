import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireAuthorization } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { config } from "../../config/index.js";
import { sendNotification } from "../../services/pushService.js";
import { pushSendRateLimit } from "../../middleware/rateLimit.js";
import { replaySyncBatch } from "../../services/pwaSyncService.js";
import { AppError } from "../../middleware/errors.js";
import { ALL_ROLES } from "../../auth/roles.js";

const router = Router();

function assertIntPwaAllowed(): void {
  if (config.isProduction) {
    throw new AppError("not_found", "Not available in production.", 404);
  }
  if (config.internal.enableTestRoutes !== "true") {
    throw new AppError("not_found", "Internal test routes disabled.", 404);
  }
}

router.post(
  "/pwa/test-push",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  pushSendRateLimit(),
  safeHandler(async (req: Request, res: Response, _next: NextFunction) => {
    assertIntPwaAllowed();
    const payload = {
      type: "alert" as const,
      title: "Test notification",
      body: "Staff PWA test push",
      level: "normal" as const,
      sound: false,
      data: "/",
    };
    const result = await sendNotification(
      { userId: req.user!.userId, role: req.user!.role },
      payload
    );
    res.status(200).json({ ok: true, result });
  })
);

router.post(
  "/pwa/test-sync",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  safeHandler(async (req: Request, res: Response, _next: NextFunction) => {
    assertIntPwaAllowed();
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

export default router;
