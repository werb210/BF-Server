import jwt from "jsonwebtoken";
import { Router } from "express";
import crypto from "crypto";

import { redis } from "../lib/redis";

const router = Router();
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_START_RATE_LIMIT_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET ?? "otp-dev-secret";

type OtpRecord = {
  codeHash: string;
  attempts: number;
  expiresAt: number;
};

const otpRequestStore: Record<string, number> = {};

export function resetOtpStateForTests(): void {
  Object.keys(otpRequestStore).forEach((phone) => {
    delete otpRequestStore[phone];
  });
}

function otpKey(phone: string): string {
  return `otp:${phone}`;
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

router.post("/otp/start", async (req, res) => {
  try {
    const { phone } = req.body as { phone?: unknown };

    if (!isPhone(phone)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const now = Date.now();
    const recentRequestAt = otpRequestStore[phone];
    if (recentRequestAt && now - recentRequestAt < OTP_START_RATE_LIMIT_MS) {
      return res.status(429).json({ error: "Too many requests" });
    }

    const code = "123456";
    await redis.set(
      otpKey(phone),
      JSON.stringify({
        codeHash: hashOtp(code),
        attempts: 0,
        expiresAt: now + OTP_TTL_MS,
      }),
      "PX",
      OTP_TTL_MS,
    );
    otpRequestStore[phone] = now;

    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ error: "internal_error" });
  }
});

router.post("/otp/verify", async (req, res) => {
  try {
    const { phone, code } = req.body as { phone?: unknown; code?: unknown };

    if (!isPhone(phone) || !isCode(code)) {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const data = await redis.get(otpKey(phone));
    if (!data) {
      return res.status(400).json({ error: "Invalid code" });
    }

    let otpRecord: OtpRecord;
    try {
      otpRecord = JSON.parse(data) as OtpRecord;
    } catch {
      await redis.del(otpKey(phone));
      return res.status(410).json({ error: "OTP expired" });
    }

    otpRecord.attempts += 1;
    if (otpRecord.expiresAt <= Date.now()) {
      await redis.del(otpKey(phone));
      return res.status(410).json({ error: "OTP expired" });
    }
    await redis.set(otpKey(phone), JSON.stringify(otpRecord), "KEEPTTL");

    if (otpRecord.attempts > OTP_MAX_ATTEMPTS) {
      await redis.del(otpKey(phone));
      return res.status(429).json({ error: "Too many attempts" });
    }

    if (otpRecord.codeHash !== hashOtp(code)) {
      return res.status(400).json({ error: "Invalid code" });
    }

    await redis.del(otpKey(phone));

    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const token = jwt.sign({ phone }, jwtSecret, { expiresIn: "7d" });
    return res.status(200).json({ ok: true, token });
  } catch {
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
