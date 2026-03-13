import { Router } from "express";
import jwt from "jsonwebtoken";
import authRoutes from "../modules/auth/auth.routes";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { notFoundHandler } from "../middleware/errors";
import { errorHandler } from "../middleware/errorHandler";
import { authMeHandler } from "./auth/me";
import { ALL_ROLES } from "../auth/roles";

const router = Router();
const otpStore = new Map<string, { code: string; expiresAt: number }>();
const OTP_TTL_MS = 5 * 60 * 1000;

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.post("/request", (req, res) => {
  const { phone } = (req.body ?? {}) as { phone?: string };

  if (!phone) {
    res.status(400).json({ ok: false, error: "missing_parameters" });
    return;
  }

  otpStore.set(phone, {
    code: "123456",
    expiresAt: Date.now() + OTP_TTL_MS,
  });

  res.status(200).json({ ok: true });
});

router.post("/verify", (req, res) => {
  const { phone, code } = (req.body ?? {}) as { phone?: string; code?: string };

  if (!phone || !code) {
    res.status(400).json({ ok: false, error: "missing_parameters" });
    return;
  }

  const otp = otpStore.get(phone);
  if (!otp || otp.expiresAt < Date.now() || otp.code !== code) {
    res.status(400).json({ ok: false, verified: false, error: "invalid_code" });
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ ok: false, error: "auth_not_configured" });
    return;
  }

  otpStore.delete(phone);

  const token = jwt.sign({ sub: phone, role: "Admin", phone, silo: "default" }, secret, {
    expiresIn: "1h",
  });

  res.status(200).json({ ok: true, verified: true, token });
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
