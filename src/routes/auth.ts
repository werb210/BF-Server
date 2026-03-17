import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import { startOtp } from "../modules/auth/otp.service";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { notFoundHandler } from "../middleware/errors";
import { errorHandler } from "../middleware/errorHandler";
import { authMeHandler } from "./auth/me";
import { ALL_ROLES } from "../auth/roles";
import { normalizeOtpPhone } from "../modules/auth/phone";
import { normalizePhone } from "../utils/normalizePhone";
import { createOtpSessionsTable } from "../db/migrations/createOtpSessions";

const router = Router();

router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.post("/otp/request", async (req, res) => {
  try {
    const rawPhone = normalizePhone(String(req.body?.phone ?? ""));
    const phone = normalizeOtpPhone(typeof rawPhone === "string" ? rawPhone : "");

    if (!phone) {
      return res.status(400).json({ error: "phone_required" });
    }

    await createOtpSessionsTable();
    await startOtp(phone);

    return res.json({
      success: true,
    });
  } catch (err) {
    console.error("OTP request failed", err);
    return res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : "otp_request_failed",
    });
  }
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
