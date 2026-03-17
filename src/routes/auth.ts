import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes";
import { startOtp, verifyOtpCode } from "../modules/auth/otp.service";
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

router.post("/otp/verify", async (req, res) => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("OTP verify timeout")), 5000)
  );

  try {
    const rawPhone = normalizePhone(String(req.body.phone ?? ""));
    const phone = normalizeOtpPhone(rawPhone);
    const code = String(req.body.code ?? "").trim();

    if (!phone || !code) {
      return res.status(400).json({
        ok: false,
        data: null,
        error: "missing_fields",
      });
    }

    const result = await Promise.race([
      verifyOtpCode({
        phone,
        code,
        ip: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
        route: req.originalUrl,
        method: req.method,
      }),
      timeout,
    ]);

    if (!result.ok) {
      return res.status(result.status).json({
        ok: false,
        data: null,
        error: result.error.code === "invalid_code" ? "invalid_otp" : result.error.code,
      });
    }

    if (!result.token || !result.sessionToken || !result.user) {
      return res.status(401).json({
        ok: false,
        data: null,
        error: "auth_token_creation_failed",
      });
    }

    return res.json({
      ok: true,
      data: {
        token: result.token,
        sessionToken: result.sessionToken,
        user: result.user,
        nextPath: result.nextPath,
      },
      error: null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      data: null,
      error: err instanceof Error ? err.message : "otp_verify_failed",
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
