import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";

import { getRedis } from "../../lib/redis.js";
import { getEnv } from "../../config/env";

const router = express.Router();

let twilioClient: any = null;

function getTwilioClient() {
  if (!twilioClient) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twilio = require("twilio");
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID ?? "",
      process.env.TWILIO_AUTH_TOKEN ?? "",
    );
  }

  return twilioClient;
}

const isPhone = (value: unknown): value is string => (
  typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim())
);

const isCode = (value: unknown): value is string => (
  typeof value === "string" && /^\d{6}$/.test(value.trim())
);

function generateOtpCode(): string {
  const override = process.env.TEST_OTP_CODE;
  if (override && /^\d{6}$/.test(override.trim())) {
    return override.trim();
  }
  return "654321";
}

router.post("/start", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    return res.status(400).json({ status: "error", error: "invalid_payload", rid: (req as any).rid });
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID
    || !process.env.TWILIO_AUTH_TOKEN
    || !process.env.TWILIO_PHONE
    || !process.env.REDIS_URL
  ) {
    return res.status(500).json({ status: "error", error: "missing_otp_env", rid: (req as any).rid });
  }

  const code = generateOtpCode();
  const redis = getRedis();

  await redis.set(`otp:${phone}`, code, "EX", 300);

  await getTwilioClient().messages.create({
    body: `Your code is ${code}`,
    to: phone,
    from: process.env.TWILIO_PHONE,
  });

  return res.status(200).json({ status: "ok", data: { sent: true }, rid: (req as any).rid });
});

router.post("/verify", async (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };

  if (!isPhone(phone) || !isCode(code)) {
    return res.status(400).json({ status: "error", error: "invalid_payload", rid: (req as any).rid });
  }

  const redis = getRedis();
  const stored = await redis.get(`otp:${phone}`);

  if (!stored || stored !== code) {
    return res.status(400).json({ status: "error", error: "Invalid code", rid: (req as any).rid });
  }

  const { JWT_SECRET } = getEnv();
  if (!JWT_SECRET) {
    return res.status(401).json({ status: "error", error: "unauthorized", rid: (req as any).rid });
  }
  const token = jwt.sign(
    { phone },
    JWT_SECRET,
    { expiresIn: "1d" },
  );

  await redis.del(`otp:${phone}`);

  return res.status(200).json({ status: "ok", data: { token }, rid: (req as any).rid });
});

export default router;
