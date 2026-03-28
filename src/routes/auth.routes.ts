import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import twilio from "twilio";

import { redis } from "../lib/redis";

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

router.post("/otp/start", async (req: Request, res: Response) => {
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
    return res.status(500).json({ error: "missing_otp_env" });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await redis.set(`otp:${phone}`, code, "EX", 300);

  await client.messages.create({
    body: `Your code is ${code}`,
    to: phone,
    from: process.env.TWILIO_PHONE,
  });

  return res.status(200).json({ success: true });
});

router.post("/otp/verify", async (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };

  if (!isPhone(phone) || !isCode(code)) {
    return res.status(400).json({ error: "invalid_payload" });
  }

  if (!process.env.JWT_SECRET) {
    return res.status(500).json({ error: "missing_jwt_secret" });
  }

  const stored = await redis.get(`otp:${phone}`);

  if (!stored || stored !== code) {
    return res.status(400).json({ error: "Invalid code" });
  }

  const token = jwt.sign(
    { phone },
    process.env.JWT_SECRET,
    { expiresIn: "1d" },
  );

  await redis.del(`otp:${phone}`);

  return res.status(200).json({ token });
});

export default router;
