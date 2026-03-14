import { Router } from "express";
import rateLimit from "express-rate-limit";
import { startOtp, verifyOtpCode } from "../../modules/auth/otp.service";
import {
  otpVerifyLimiter,
  resetOtpRateLimit,
} from "../../middleware/rateLimit";
import { normalizePhoneNumber } from "../../modules/auth/phone";

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
    const { phone } = req.body ?? {};

    const normalizedPhone = normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        ok: false,
        success: false,
        error: "Phone required",
      });
    }

    const reused = hasRecentOtpStart(normalizedPhone);
    if (!reused) {
      await startOtp(normalizedPhone);
      markRecentOtpStart(normalizedPhone);
    }

    const requestId = res.locals.requestId ?? "unknown";
    return res.json({
      ok: true,
      success: true,
      reused,
      data: {
        sent: !reused,
        reused,
      },
      error: null,
      requestId,
    });
  } catch (err) {
    return next(err);
  }
});

router.post("/verify", otpVerifyLimiter(), async (req, res, next) => {
  const body = req.body || {};

  const phone = body.phone || body.phoneNumber || body.mobile || body.userPhone;

  const code = body.code || body.otp || body.passcode;

  if (!phone || !code) {
    req.log?.warn({
      event: "otp_missing_fields",
      body,
    });

    return res.status(400).json({
      error: "Invalid request",
      message: "phone and code required",
    });
  }

  const normalizedCode = String(code).trim();
  const normalizedPhone = normalizePhoneNumber(phone);

  if (!normalizedPhone || !normalizedCode) {
    req.log?.warn({
      event: "otp_missing_fields",
      body,
    });

    return res.status(400).json({
      error: "Invalid request",
      message: "phone and code required",
    });
  }

  if (activeVerifications.get(normalizedPhone)) {
    return res.status(429).json({
      success: false,
      error: "Verification already in progress",
    });
  }

  activeVerifications.set(normalizedPhone, true);

  try {
    req.log?.info({
      event: "otp_verification_attempt",
      phone: normalizedPhone,
    });

    const email = body.email;
    const userAgent = req.get("user-agent");
    const route = req.originalUrl ?? req.url;
    const payload = {
      phone: normalizedPhone,
      code: normalizedCode,
      email,
      ...(req.ip ? { ip: req.ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(route ? { route } : {}),
      ...(req.method ? { method: req.method } : {}),
    };
    const result = await verifyOtpCode(payload);
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        error: "Invalid OTP",
      });
    }
    resetOtpRateLimit(normalizedPhone);
    return res.status(200).json({
      ok: true,
      success: true,
      accessToken: result.token,
      token: result.token,
      user: {
        id: result.user.id,
        role: result.user.role,
      },
    });
  } catch (err) {
    req.log?.error({
      event: "otp_verification_error",
      error: err,
    });

    return res.status(500).json({
      error: "OTP verification failed",
    });
  } finally {
    activeVerifications.delete(normalizedPhone);
  }
});

export default router;
