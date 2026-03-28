import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import twilio from "twilio";

import { redis, resetRedisMock } from "../lib/redis";
import { fail, ok } from "../lib/response";

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

router.post("/otp/start", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    return fail(res, "invalid_payload", 400);
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID
    || !process.env.TWILIO_AUTH_TOKEN
    || !process.env.TWILIO_PHONE
    || !process.env.REDIS_URL
  ) {
    return fail(res, "missing_otp_env", 500);
  }

  const now = Date.now();
  const key = `otp:${phone}`;
  const existingRaw = await redis.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) as OtpRecord : null;

  if (existing && now - existing.lastSentAt < 60_000) {
    return fail(res, "Too many requests", 429);
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
    return fail(res, "invalid_payload", 400);
  }

  if (!process.env.JWT_SECRET) {
    return fail(res, "unauthorized", 401);
  }

  const stored = await redis.get(`otp:${phone}`);

  if (!stored) {
    return fail(res, "Invalid code", 400);
  }

  const record = JSON.parse(stored) as OtpRecord;
  const now = Date.now();

  if (now > record.expiresAt) {
    await redis.del(`otp:${phone}`);
    return fail(res, "OTP expired", 410);
  }

  if (record.used) {
    return fail(res, "Invalid code", 400);
  }

  if (record.code !== code) {
    record.attempts += 1;
    if (record.attempts >= 5) {
      await redis.del(`otp:${phone}`);
    } else {
      await redis.set(`otp:${phone}`, JSON.stringify(record), "EX", 300);
    }
    return fail(res, "Invalid code", 400);
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
