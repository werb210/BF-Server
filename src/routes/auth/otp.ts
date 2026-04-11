import express, { type Request, type Response } from "express";
import { randomInt } from "node:crypto";
import jwt from "jsonwebtoken";
import twilio from "twilio";

import { getRedis } from "../../lib/redis.js";
import { findAuthUserByPhone } from "../../modules/auth/auth.repo.js";

const router = express.Router();

const isPhone = (value: unknown): value is string => (
  typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim())
);

const isCode = (value: unknown): value is string => (
  typeof value === "string" && /^\d{6}$/.test(value.trim())
);

router.post("/start", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID
    || !process.env.TWILIO_AUTH_TOKEN
    || !process.env.TWILIO_PHONE
    || !process.env.REDIS_URL
  ) {
    if (process.env.NODE_ENV === "test") {
      return res.status(200).json({ status: "ok", data: { sent: true } });
    }
    return res.status(500).json({ error: "missing_otp_env" });
  }

  const code = randomInt(100000, 1000000).toString();
  const redis = getRedis();

  await redis.set(`otp:${phone}`, code, "EX", 300);

  if (process.env.NODE_ENV === "test") {
    return res.status(200).json({ status: "ok", data: { sent: true } });
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID ?? "", process.env.TWILIO_AUTH_TOKEN ?? "");

  try {
    await client.messages.create({
      body: `Your Boreal Financial verification code is ${code}`,
      to: phone,
      from: process.env.TWILIO_PHONE,
    });

    return res.status(200).json({ status: "ok", data: { sent: true } });
  } catch (err) {
    console.error("Twilio SMS failed:", err);
    return res.status(500).json({ error: "sms_failed" });
  }
});

router.post("/verify", async (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };

  if (!isPhone(phone) || !isCode(code)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  const redis = getRedis();
  const stored = await redis.get(`otp:${phone}`);

  if (!stored || stored !== code) {
    return res.status(400).json({ error: "Invalid code" });
  }

  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let sub: string;
  let role: string;
  let tokenVersion: number;
  let silo: string | null = null;

  try {
    const user = await findAuthUserByPhone(phone);
    if (!user) {
      return res.status(401).json({
        error: "user_not_found",
        message: "No staff account found for this phone number. Contact your administrator.",
      });
    }
    if (!user.role) {
      return res.status(403).json({
        error: "no_role",
        message: "Account exists but has no role assigned. Contact your administrator.",
      });
    }
    if (user.disabled || !user.active) {
      return res.status(403).json({ error: "account_disabled" });
    }
    sub = user.id;
    role = user.role;
    tokenVersion = user.tokenVersion ?? 0;
    silo = user.silo ?? null;
  } catch (err) {
    console.error("OTP verify DB lookup failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }

  const token = jwt.sign(
    {
      sub,
      role,
      phone,
      tokenVersion,
      ...(silo ? { silo } : {}),
    },
    JWT_SECRET,
    { expiresIn: "1d" },
  );

  await redis.del(`otp:${phone}`);

  return res.status(200).json({ status: "ok", data: { token } });
});

export default router;
