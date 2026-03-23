import { Router, Request, Response, NextFunction } from "express";
import { requireAuth, requireAuthorization } from "../../middleware/auth";
import { safeHandler } from "../../middleware/safeHandler";
import { isProductionEnvironment } from "../../server/config/env.compat";
import { sendNotification } from "../../services/pushService";
import { pushSendRateLimit } from "../../middleware/rateLimit";
import { replaySyncBatch } from "../../services/pwaSyncService";
import { AppError } from "../../middleware/errors";
import { ALL_ROLES } from "../../auth/roles";

const router = Router();

function assertIntPwaAllowed(): void {
  if (isProductionEnvironment()) {
    throw new AppError("not_found", "Not available in production.", 404);
  }
  if (process.env.ENABLE_INT_TEST_ROUTES !== "true") {
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
