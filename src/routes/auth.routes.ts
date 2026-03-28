import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import twilio from "twilio";

import { redis, resetRedisMock } from "../lib/redis";

const router = Router();

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID ?? "",
  process.env.TWILIO_AUTH_TOKEN ?? "",
);

const isPhone = (value: unknown): value is string => (
  typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim())
);

const isCode = (value: unknown): value is string => (
  typeof value === "string" && /^\d{6}$/.test(value.trim())
);

type OtpRecord = {
  code: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  used: boolean;
};

export function resetOtpStateForTests() {
  resetRedisMock();
}

function ok(res: Response, data: Record<string, unknown> = {}) {
  return res.status(200).json({ success: true, data });
}

function fail(res: Response, status: number, error: string) {
  return res.status(status).json({ success: false, error });
}

router.post("/otp/start", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    return fail(res, 400, "invalid_payload");
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID
    || !process.env.TWILIO_AUTH_TOKEN
    || !process.env.TWILIO_PHONE
    || !process.env.REDIS_URL
  ) {
    return fail(res, 500, "missing_otp_env");
  }

  const now = Date.now();
  const key = `otp:${phone}`;
  const existingRaw = await redis.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) as OtpRecord : null;

  if (existing && now - existing.lastSentAt < 60_000) {
    return fail(res, 429, "Too many requests");
  }

  const staticOtpCode = process.env.TEST_OTP_CODE;
  const code = staticOtpCode
    ? staticOtpCode
    : Math.floor(100000 + Math.random() * 900000).toString();

  const record: OtpRecord = {
    code,
    expiresAt: now + (5 * 60 * 1000),
    attempts: 0,
    lastSentAt: now,
    used: false,
  };

  await redis.set(key, JSON.stringify(record), "EX", 300);

  if (!staticOtpCode) {
    await client.messages.create({
      body: `Your code is ${code}`,
      to: phone,
      from: process.env.TWILIO_PHONE,
    });
  }

  return ok(res);
});

router.post("/otp/verify", async (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };

  if (!isPhone(phone) || !isCode(code)) {
    return fail(res, 400, "invalid_payload");
  }

  if (!process.env.JWT_SECRET) {
    return fail(res, 401, "unauthorized");
  }

  const stored = await redis.get(`otp:${phone}`);

  if (!stored) {
    return fail(res, 400, "Invalid code");
  }

  const record = JSON.parse(stored) as OtpRecord;
  const now = Date.now();

  if (now > record.expiresAt) {
    await redis.del(`otp:${phone}`);
    return fail(res, 410, "OTP expired");
  }

  if (record.used) {
    return fail(res, 400, "Invalid code");
  }

  if (record.code !== code) {
    record.attempts += 1;
    if (record.attempts >= 5) {
      await redis.del(`otp:${phone}`);
    } else {
      await redis.set(`otp:${phone}`, JSON.stringify(record), "EX", 300);
    }
    return fail(res, 400, "Invalid code");
  }

  const token = jwt.sign(
    { phone },
    process.env.JWT_SECRET,
    { expiresIn: "1d" },
  );

  await redis.del(`otp:${phone}`);

  return ok(res, { token });
});

export default router;
