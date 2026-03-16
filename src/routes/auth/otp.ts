import { Router } from "express";
import rateLimit from "express-rate-limit";
import { startOtp, verifyOtpCode } from "../../modules/auth/otp.service";
import {
  otpVerifyLimiter,
  resetOtpRateLimit,
} from "../../middleware/rateLimit";
import { otpStartSchema } from "../../validation/auth.validation";

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

router.post("/start", otpLimiter, async (req, res) => {
  try {
    const { phone } = otpStartSchema.parse({
      phone: req.body?.phone ?? req.body?.phoneNumber,
    });

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
      ok: true,
      data: {
        sent: true,
        otpSessionId: otpSessionId ?? "reused",
        ...(otp ? { otp } : {}),
      },
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: {
        code: "invalid_request",
        message: err instanceof Error ? err.message : "Invalid request",
      },
    });
  }
});

router.post("/verify", otpVerifyLimiter(), async (req, res) => {
  let phoneForLock: string | null = null;

  try {
    const rawPhone = req.body?.phone ?? req.body?.phoneNumber;
    const rawCode = req.body?.code;

    const { phone } = otpStartSchema.parse({ phone: rawPhone });
    phoneForLock = phone;
    const code = typeof rawCode === "string" ? rawCode.trim() : "";

    if (!code) {
      return res.status(400).json({
        ok: false,
        error: { code: "invalid_code", message: "Invalid verification code" },
      });
    }

    if (activeVerifications.get(phone)) {
      return res.status(429).json({
        ok: false,
        error: { code: "verify_in_progress", message: "Verification already in progress" },
      });
    }

    activeVerifications.set(phone, true);

    const userAgent = req.get("user-agent");
    const route = req.originalUrl ?? req.url;
    const payload = {
      phone,
      code,
      ...(req.ip ? { ip: req.ip } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(route ? { route } : {}),
      ...(req.method ? { method: req.method } : {}),
    };
    const result = await verifyOtpCode(payload);

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: { code: "invalid_code", message: "Invalid verification code" },
      });
    }

    resetOtpRateLimit(phone);

    return res.status(200).json({
      ok: true,
      data: {
        token: result.token,
        user: result.user,
      },
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      error: {
        code: "verify_failed",
        message: err instanceof Error ? err.message : "OTP verification failed",
      },
    });
  } finally {
    if (phoneForLock) {
      activeVerifications.delete(phoneForLock);
    }
  }
});

export default router;
