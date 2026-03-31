import { Router } from "express";
import jwt from "jsonwebtoken";

import { signJwt, verifyJwt } from "../auth/jwt";
import { requireAuth } from "../middleware/auth";
import { getRedis, resetRedisMock } from "../lib/redis";
import { sendSMS } from "../lib/twilio";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET as string;

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
  return res.status(200).json(req.user);
});

async function startOtp(phone: string): Promise<{ success: true }> {
  const redis = getRedis();
  const now = Date.now();
  const key = `otp:${phone}`;
  const existingRaw = await redis.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) as OtpRecord : null;

  if (existing && now - existing.lastSentAt < 60_000) {
    throw new Error("TOO_MANY_REQUESTS");
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

  if (
    !staticOtpCode
    && process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_PHONE
  ) {
    await sendSMS(String(phone), `Your code is ${code}`);
  }

  return { success: true };
}

async function verifyOtp(phone: string, code: string): Promise<string | null> {
  const redis = getRedis();
  const stored = await redis.get(`otp:${phone}`);

  if (!stored) {
    return null;
  }

  const record = JSON.parse(stored) as OtpRecord;
  const now = Date.now();

  if (now > record.expiresAt) {
    await redis.del(`otp:${phone}`);
    return null;
  }

  if (record.used) {
    return null;
  }

  if (record.code !== code) {
    record.attempts += 1;
    if (record.attempts >= 5) {
      await redis.del(`otp:${phone}`);
    } else {
      await redis.set(`otp:${phone}`, JSON.stringify(record), "EX", 300);
    }
    return null;
  }

  if (!JWT_SECRET) {
    throw new Error("SERVER_MISCONFIG");
  }

  const token = jwt.sign({ phone }, JWT_SECRET, { expiresIn: "7d" });
  await redis.del(`otp:${phone}`);
  return token;
}

// START OTP
router.post("/start-otp", async (req, res) => {
  const phone = req.body?.phone;

  if (typeof phone !== "string" || phone.trim().length < 5) {
    return res.status(400).json({ error: "INVALID_PHONE" });
  }

  try {
    const result = await startOtp(phone);
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "TOO_MANY_REQUESTS") {
      return res.status(429).json({ error: "TOO_MANY_REQUESTS" });
    }
    return res.status(500).json({ error: "OTP_START_FAILED" });
  }
});

// VERIFY OTP
router.post("/verify-otp", async (req, res) => {
  const { phone, code } = req.body || {};

  if (
    typeof phone !== "string"
    || typeof code !== "string"
    || code.trim().length < 4
  ) {
    return res.status(400).json({ error: "INVALID_INPUT" });
  }

  try {
    const token = await verifyOtp(phone, code);

    if (!token) {
      return res.status(401).json({ error: "INVALID_CODE" });
    }

    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ error: "OTP_VERIFY_FAILED" });
  }
});

router.post("/refresh", async (req, res) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  const token = header.slice(7);

  try {
    const decoded = verifyJwt(token);
    const newToken = signJwt(decoded);

    return res.status(200).json({ token: newToken });
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
});


export default router;
