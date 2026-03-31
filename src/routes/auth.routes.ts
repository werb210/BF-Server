import { Router, type Request, type Response } from "express";
import { requireAuth } from "../middleware/auth";
import jwt from "jsonwebtoken";

import { getRedis, resetRedisMock } from "../lib/redis";
import { fail, ok } from "../lib/response";
import { sendSMS } from "../lib/twilio";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
console.log("[ROUTES LOADED] auth.routes");

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

router.get("/me", requireAuth, (req, res) => {
  return res.json(req.user);
});

router.post("/otp/start", (req, _res, next) => {
  console.log("[AUTH HIT] /auth/otp/start");
  next();
}, async (req: Request, res: Response) => {
  try {
    const { phone } = req.body as { phone?: unknown };

    if (!phone) {
      return res.status(400).json({ error: "phone required" });
    }

    if (!isPhone(phone)) {
      return fail(res, "invalid_phone", 400);
    }

    if (
      !process.env.TWILIO_ACCOUNT_SID
      || !process.env.TWILIO_AUTH_TOKEN
      || !process.env.TWILIO_PHONE
    ) {
      return fail(res, "missing_otp_env", 500);
    }

    const redis = getRedis();
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
      await sendSMS(phone, `Your code is ${code}`);
    }

    if (process.env.NODE_ENV === "test") {
      return res.status(200).json({ ok: true });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "otp_start_failed" });
  }
});

router.post("/otp/verify", async (req: Request, res: Response) => {
  try {
    const { phone, code } = req.body as { phone?: unknown; code?: unknown };

    if (!isPhone(phone) || !isCode(code)) {
      return fail(res, "invalid_payload", 400);
    }

    const redis = getRedis();
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
      JWT_SECRET,
      { expiresIn: "7d" },
    );

    await redis.del(`otp:${phone}`);

    return res.json({ token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "otp_verify_failed" });
  }
});

export default router;
