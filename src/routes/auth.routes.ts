import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";

import { requireAuth } from "../middleware/auth";
import { signJwt, verifyJwt } from "../auth/jwt";
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

async function startOtpHandler(req: Request, res: Response) {
  try {
    const { phone } = req.body as { phone?: unknown };

    if (typeof phone !== "string" || phone.length < 5) {
      return res.status(400).json({ error: "INVALID_PHONE" });
    }

    const redis = getRedis();
    const now = Date.now();
    const key = `otp:${phone}`;
    const existingRaw = await redis.get(key);
    const existing = existingRaw ? JSON.parse(existingRaw) as OtpRecord : null;

    if (existing && now - existing.lastSentAt < 60_000) {
      return res.status(429).json({ error: "TOO_MANY_REQUESTS" });
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

    if (process.env.NODE_ENV === "test") {
      return res.status(200).json({ success: true });
    }

    return res.status(200).json({ success: true });
  } catch {
    return res.status(500).json({ error: "OTP_START_FAILED" });
  }
}

async function verifyOtpHandler(req: Request, res: Response) {
  try {
    const { phone, code } = req.body as { phone?: unknown; code?: unknown };

    if (
      typeof phone !== "string"
      || typeof code !== "string"
      || code.length < 4
    ) {
      return res.status(400).json({ error: "INVALID_INPUT" });
    }

    const redis = getRedis();
    const stored = await redis.get(`otp:${phone}`);

    if (!stored) {
      return res.status(400).json({ error: "INVALID_TOKEN" });
    }

    const record = JSON.parse(stored) as OtpRecord;
    const now = Date.now();

    if (now > record.expiresAt) {
      await redis.del(`otp:${phone}`);
      return res.status(410).json({ error: "OTP_EXPIRED" });
    }

    if (record.used) {
      return res.status(400).json({ error: "INVALID_TOKEN" });
    }

    if (record.code !== code) {
      record.attempts += 1;
      if (record.attempts >= 5) {
        await redis.del(`otp:${phone}`);
      } else {
        await redis.set(`otp:${phone}`, JSON.stringify(record), "EX", 300);
      }
      return res.status(401).json({ error: "INVALID_CODE" });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: "SERVER_MISCONFIG" });
    }

    const token = jwt.sign(
      { phone },
      JWT_SECRET,
      { expiresIn: "7d" },
    );

    await redis.del(`otp:${phone}`);

    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ error: "OTP_VERIFY_FAILED" });
  }
}

router.post("/start-otp", startOtpHandler);
router.post("/verify-otp", verifyOtpHandler);
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

router.post("/otp/start", startOtpHandler);
router.post("/otp/verify", verifyOtpHandler);

export default router;
