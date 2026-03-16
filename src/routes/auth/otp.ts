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

function normalizePhone(input: string): string {
  if (!input) return "";

  let phone = input.trim();

  // remove everything except digits and +
  phone = phone.replace(/[^\d+]/g, "");

  // remove leading +
  if (phone.startsWith("+")) {
    phone = phone.slice(1);
  }

  // convert 10 digit → Canadian format
  if (phone.length === 10) {
    phone = "1" + phone;
  }

  // convert 11 digit starting with 1 → keep
  if (phone.length === 11 && phone.startsWith("1")) {
    return "+" + phone;
  }

  return "+" + phone;
}

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
      return res.status(400).json({
        ok: false,
        error: "phone_required",
      });
    }

    req.body = { ...rawBody, phone: phoneRaw };

    if (req.body.phone) {
      req.body.phone = normalizePhone(req.body.phone);
    }

    const parsed = otpStartSchema.parse(req.body);

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
      error: "invalid_request",
    });
  }
});

router.post("/verify", otpVerifyLimiter(), async (req, res) => {
  let phoneForLock: string | null = null;

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
      return res.status(400).json({
        ok: false,
        error: "invalid_payload",
      });
    }

    req.body = { ...rawBody, phone: phoneRaw };

    if (req.body.phone) {
      req.body.phone = normalizePhone(req.body.phone);
    }

    const parsed = otpStartSchema.parse(req.body);
    const phone = parsed.phone;
    phoneForLock = phone;
    const parsedCode = typeof code === "string" ? code.trim() : "";

    if (!parsedCode) {
      return res.status(400).json({
        ok: false,
        error: "invalid_code",
      });
    }

    if (activeVerifications.get(phone)) {
      return res.status(429).json({
        ok: false,
        error: "verify_in_progress",
      });
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
      return res.status(400).json({
        ok: false,
        error: "invalid_code",
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
      error: "verify_failed",
    });
  } finally {
    if (phoneForLock) {
      activeVerifications.delete(phoneForLock);
    }
  }
});

export default router;
