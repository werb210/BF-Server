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

  const code = process.env.NODE_ENV === "test" ? "000000" : generateOtpCode();

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

    const code = process.env.NODE_ENV === "test" ? "000000" : "unknown";
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
    return res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : "otp_request_failed",
    });
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
    const body = req.body;
    const parsedRawBody =
      typeof body === "string"
        ? (() => {
            const trimmed = body.trim();
            if (!trimmed) {
              return {};
            }
            try {
              return JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              return Object.fromEntries(new URLSearchParams(trimmed).entries());
            }
          })()
        : Buffer.isBuffer(body)
          ? (() => {
              const trimmed = body.toString("utf8").trim();
              if (!trimmed) {
                return {};
              }
              try {
                return JSON.parse(trimmed) as Record<string, unknown>;
              } catch {
                return Object.fromEntries(new URLSearchParams(trimmed).entries());
              }
            })()
          : body;

    const rawBody =
      parsedRawBody && typeof parsedRawBody === "object" ? parsedRawBody : {};

    const phone =
      rawBody.phone ??
      rawBody.phoneNumber ??
      rawBody.mobile ??
      rawBody.userPhone ??
      null;

    const code =
      rawBody.code ??
      rawBody.otp ??
      rawBody.passcode ??
      rawBody.token ??
      null;

    if (!phone || !code) {
      req.log?.warn({
        event: "otp_missing_fields",
        received: rawBody,
      });

      return res.status(400).json({
        error: "missing_fields",
      });
    }

    const normalizedPhone = normalizePhone(String(phone));
    const normalizedCode = String(code).trim();

    if (!normalizedCode) {
      return res.status(400).json({ error: "Code required" });
    }

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
    if (!result.ok) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    const sessionToken = result.sessionToken;

    return res.json({
      ok: true,
      sessionToken,
      nextPath: "/application/start",
    });
  } catch (err) {
    req.log?.error({
      event: "otp_verify_failure",
      error: err,
    });

    return res.status(400).json({
      success: false,
      message: err instanceof Error ? err.message : "OTP verification failed",
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
