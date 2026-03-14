import { Router } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import authRoutes from "../modules/auth/auth.routes";
import { startOtp, verifyOtpCode } from "../modules/auth/otp.service";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { notFoundHandler } from "../middleware/errors";
import { errorHandler } from "../middleware/errorHandler";
import { authMeHandler } from "./auth/me";
import { ALL_ROLES } from "../auth/roles";
import { normalizePhone } from "../utils/phoneNormalizer";
import { db } from "../db";
import { createOtpSessionsTable } from "../db/migrations/createOtpSessions";

const router = Router();
const otpStore = new Map<string, { code: string; expiresAt: number }>();
const OTP_TTL_MS = 5 * 60 * 1000;

function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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

  const code = process.env.NODE_ENV === "production" ? generateOtpCode() : "123456";

  otpStore.set(phone, {
    code,
    expiresAt: Date.now() + OTP_TTL_MS,
  });

  res.status(200).json({ ok: true });
});

router.post("/request-otp", async (req, res) => {
  try {
    const rawPhone = req.body?.phone;
    const phone = normalizePhone(typeof rawPhone === "string" ? rawPhone : "");

    if (!phone) {
      return res.status(400).json({ error: "phone_required" });
    }

    await createOtpSessionsTable();
    await startOtp(phone);

    const code = process.env.NODE_ENV === "production" ? "unknown" : "123456";
    const sessionId = crypto.randomUUID();

    await db.query(
      `
      INSERT INTO otp_sessions (id, phone, code, expires_at)
      VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')
      `,
      [sessionId, phone, code]
    );

    return res.json({
      success: true,
      sessionId,
    });
  } catch (err) {
    console.error("OTP request failed", err);
    return res.status(500).json({ error: "otp_request_failed" });
  }
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

router.post("/verify-otp", async (req, res) => {
  try {
    console.log("verify-otp body:", req.body);
    const body = req.body || {};

    const phone =
      body.phone ||
      body.phoneNumber ||
      body.mobile ||
      body.userPhone ||
      null;

    const code =
      body.code ||
      body.otp ||
      body.passcode ||
      null;

    if (!phone || !code) {
      req.log?.warn({
        event: "otp_bad_payload",
        body,
      });

      return res.status(400).json({
        error: "Invalid payload",
        message: "phone and code required",
      });
    }

    const normalizedPhone = String(phone).trim();
    const normalizedCode = String(code).trim();

    req.log?.info({
      event: "otp_verify_attempt",
      phone: normalizedPhone,
    });

    const result = await verifyOtpCode({
      phone: normalizedPhone,
      code: normalizedCode,
      ip: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
      route: req.originalUrl,
      method: req.method,
    });
    const valid = result.ok;

    if (!valid) {
      return res.status(401).json({
        error: "Invalid OTP",
      });
    }

    return res.status(200).json({
      success: true,
    });
  } catch (err) {
    req.log?.error({
      event: "otp_verify_failure",
      error: err,
    });

    return res.status(500).json({
      error: "OTP verification failed",
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
