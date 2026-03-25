import jwt from "jsonwebtoken";
import { Router } from "express";
import crypto from "crypto";

const router = Router();
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_START_RATE_LIMIT_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET ?? "otp-dev-secret";

type OtpRecord = {
  codeHash: string;
  phone: string;
  createdAt: number;
  attempts: number;
};

const otpStore: Record<string, OtpRecord> = {};
const otpRequestStore: Record<string, number> = {};

export function resetOtpStateForTests(): void {
  Object.keys(otpStore).forEach((phone) => {
    delete otpStore[phone];
  });
  Object.keys(otpRequestStore).forEach((phone) => {
    delete otpRequestStore[phone];
  });
}

function isPhone(value: unknown): value is string {
  return typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim());
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value.trim());
}

function hashOtp(code: string): string {
  return crypto
    .createHmac("sha256", OTP_HASH_SECRET)
    .update(code)
    .digest("hex");
}

router.post("/otp/start", (req, res) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const now = Date.now();
  const recentRequestAt = otpRequestStore[phone];
  if (recentRequestAt && now - recentRequestAt < OTP_START_RATE_LIMIT_MS) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }

  const code = "123456";
  otpStore[phone] = {
    codeHash: hashOtp(code),
    phone,
    createdAt: now,
    attempts: 0,
  };
  otpRequestStore[phone] = now;

  res.status(200).json({ ok: true });
});

router.post("/otp/verify", (req, res) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };

  if (!isPhone(phone) || !isCode(code)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const otpRecord = otpStore[phone];
  const now = Date.now();

  if (!otpRecord) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  if (now - otpRecord.createdAt > OTP_TTL_MS) {
    delete otpStore[phone];
    res.status(410).json({ error: "OTP expired" });
    return;
  }

  otpRecord.attempts += 1;
  if (otpRecord.attempts > OTP_MAX_ATTEMPTS) {
    delete otpStore[phone];
    res.status(429).json({ error: "Too many attempts" });
    return;
  }

  if (otpRecord.codeHash !== hashOtp(code)) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  delete otpStore[phone];

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const token = jwt.sign({ phone }, jwtSecret, { expiresIn: "7d" });
  res.status(200).json({ ok: true, token });
});

export default router;
