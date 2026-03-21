import { Router } from "express";
import rateLimit from "express-rate-limit";
import { startOtp, verifyOtpCode } from "../../modules/auth/otp.service";
import {
  otpVerifyLimiter,
  resetOtpRateLimit,
} from "../../middleware/rateLimit";
import { otpStartSchema, verifyOtpSchema } from "../../validation/auth.validation";
import { normalizeOtpPhone } from "../../modules/auth/phone";

const router = Router();
const OTP_START_REUSE_WINDOW_MS = 60 * 1000;
const recentOtpStarts = new Map<string, number>();
const activeVerifications = new Map<string, boolean>();

const otpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
});

function hasRecentOtpStart(phone: string): boolean {
  const now = Date.now();
  const expiresAt = recentOtpStarts.get(phone);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= now) {
    recentOtpStarts.delete(phone);
    return false;
  }
  return true;
}

function markRecentOtpStart(phone: string): void {
  recentOtpStarts.set(phone, Date.now() + OTP_START_REUSE_WINDOW_MS);
}

router.post("/start", otpLimiter, async (req, res, next) => {
  try {
    const rawBody =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const phoneRaw =
      rawBody.phone ||
      rawBody.phoneNumber ||
      rawBody.phone_number ||
      null;

    if (!phoneRaw) {
      return res.status(204).send();
    }

    req.body = { ...rawBody, phone: phoneRaw };

    const normalizedPhone = normalizeOtpPhone(req.body.phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        code: "invalid_phone",
        message: "Invalid phone number format",
      });
    }

    const parsed = otpStartSchema.parse({ ...req.body, phone: normalizedPhone });

    const phone = parsed.phone;

    const reused = hasRecentOtpStart(phone);
    let otpSessionId: string | null = null;
    let otp: string | undefined;

    if (!reused) {
      const otpResult = await startOtp(phone);
      otpSessionId = otpResult.sid;
      otp = otpResult.otp;
      markRecentOtpStart(phone);
    }

    return res.status(200).json({
      success: true,
      ok: true,
      data: {
        sent: true,
        otpSessionId: otpSessionId ?? "reused",
        ...(otp ? { otp } : {}),
      },
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: "Invalid request",
      ok: false,
      code: "invalid_request",
    });
  }
});

router.post("/verify", otpVerifyLimiter(), async (req, res, next) => {
  let phoneForLock: string | null = null;
  const requestId = res.locals.requestId ?? "unknown";

  const fail = (code: string, message: string) => {
    return res.status(400).json({
      success: false,
      code,
      message,
      ok: false,
      data: null,
      error: {
        code,
        message,
      },
      requestId,
    });
  };

  try {
    const rawBody =
      typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body || {};

    const phoneRaw =
      rawBody.phone ||
      rawBody.phoneNumber ||
      rawBody.phone_number ||
      null;

    const code = rawBody.code || rawBody.otp || null;
    const otpSessionId = rawBody.otpSessionId || null;

    if (!phoneRaw || !code) {
      return fail("invalid_payload", "Phone and code are required");
    }

    req.body = { ...rawBody, phone: phoneRaw };

    const normalizedPhone = normalizeOtpPhone(req.body.phone);
    if (!normalizedPhone) {
      return fail("invalid_phone", "Phone number is invalid");
    }

    const parsed = verifyOtpSchema.parse({ ...req.body, phone: normalizedPhone, code });
    const phone = parsed.phone;
    phoneForLock = phone;
    const parsedCode = parsed.code.trim();

    if (!parsedCode) {
      return fail("invalid_code", "OTP code is invalid");
    }

    if (activeVerifications.get(phone)) {
      return fail("verify_in_progress", "Verification already in progress");
    }

    activeVerifications.set(phone, true);

    const userAgent = req.get("user-agent");
    const route = req.originalUrl ?? req.url;
    const payload = {
      phone,
      code: parsedCode,
      ...(otpSessionId ? { otpSessionId } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(route ? { route } : {}),
      ...(req.method ? { method: req.method } : {}),
    };
    const result = await verifyOtpCode(payload);

    if (!result.ok) {
      const errorCode = result.error.code === "invalid_code" ? "invalid_otp" : result.error.code;
      return fail(errorCode, result.error.message);
    }

    resetOtpRateLimit(phone);

    if (!result.data.token || !result.data.user) {
      return fail("auth_token_creation_failed", "Failed to create auth token");
    }

    res.cookie("token", result.data.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });

    return res.status(200).json({
      success: true,
      data: {
        accessToken: result.data.token,
        refreshToken: result.data.refreshToken,
        user: result.data.user,
        nextPath: result.data.nextPath,
      },
      ok: true,
      accessToken: result.data.token,
      user: result.data.user,
    });
  } catch (err) {
    return fail("verify_failed", "OTP verification failed");
  } finally {
    if (phoneForLock) {
      activeVerifications.delete(phoneForLock);
    }
  }
});

export default router;
