import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { notFoundHandler } from "../middleware/errors";
import { errorHandler } from "../middleware/errorHandler";
import { authMeHandler } from "./auth/me";
import { ALL_ROLES } from "../auth/roles";

const router = Router();

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.post("/verify", (req, res) => {
  const { phone, code } = (req.body ?? {}) as { phone?: string; code?: string };

  if (!phone || !code) {
    res.status(400).json({ ok: false, error: "missing_parameters" });
    return;
  }

  res.status(200).json({ ok: true, verified: true });
});

/**
 * GET /api/auth/me
 * - Auth required
 * - Uses canonical auth wrapper
 */
router.get(
  "/me",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  authMeHandler
);

/**
 * OTP + authentication flows
 * These routes manage their own auth semantics internally
 */
router.use("/", authRoutes);

/**
 * Terminal handlers
 */
router.use(notFoundHandler);
router.use(errorHandler);

export default router;
