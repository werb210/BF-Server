import express, { type Request, type Response } from "express";
import jwt from "jsonwebtoken";

import { getRedis } from "../../lib/redis";
import { getEnv } from "../../config/env";
import { fail, ok } from "../../lib/response";

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

type OtpSession = {
  code: string;
  expiresAt: number;
  invalidAttempts: number;
  lastSentAt: number;
};

const isPhone = (value: unknown): value is string => (
  typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim())
);

const isCode = (value: unknown): value is string => (
  typeof value === "string" && /^\d{6}$/.test(value.trim())
);

function generateOtpCode(): string {
  if (process.env.NODE_ENV === "test" && process.env.TEST_OTP_CODE) {
    return process.env.TEST_OTP_CODE;
  }

  return String(Math.floor(100000 + Math.random() * 900000));
}

function sessionKey(phone: string): string {
  return `otp:${phone}`;
}

async function readSession(phone: string): Promise<OtpSession | null> {
  const redis = getRedis();
  const raw = await redis.get(sessionKey(phone));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as OtpSession;
    if (!parsed || typeof parsed.code !== "string") {
      return null;
    }
    return {
      code: parsed.code,
      expiresAt: Number(parsed.expiresAt) || 0,
      invalidAttempts: Number(parsed.invalidAttempts) || 0,
      lastSentAt: Number(parsed.lastSentAt) || 0,
    };
  } catch {
    return null;
  }
}

async function writeSession(phone: string, session: OtpSession) {
  const redis = getRedis();
  const ttlSeconds = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
  await redis.set(sessionKey(phone), JSON.stringify(session), "EX", ttlSeconds);
}

router.post("/start", async (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: unknown };
  const rid = (req as any).rid;

  if (!isPhone(phone)) {
    return res.status(400).json(fail("invalid_payload", rid));
  }

  if (
    !process.env.TWILIO_ACCOUNT_SID
    || !process.env.TWILIO_AUTH_TOKEN
    || !process.env.TWILIO_PHONE
  ) {
    return res.status(500).json(fail("missing_otp_env", rid));
  }

  let redis;
  try {
    redis = getRedis();
  } catch {
    return res.status(503).json(fail("service_unavailable", rid));
  }

  const existing = await readSession(phone);
  if (existing && Date.now() - existing.lastSentAt < 60_000) {
    return res.status(429).json(fail("Too many requests", rid));
  }

  const code = generateOtpCode();
  const expiresAt = Date.now() + (5 * 60 * 1000);

  await writeSession(phone, {
    code,
    expiresAt,
    invalidAttempts: 0,
    lastSentAt: Date.now(),
  });

  if (process.env.NODE_ENV !== "test") {
    await getTwilioClient().messages.create({
      body: `Your code is ${code}`,
      to: phone,
      from: process.env.TWILIO_PHONE,
    });
  }

  return res.status(200).json(ok({ sent: true }, rid));
});

router.post("/verify", async (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };
  const rid = (req as any).rid;

  if (!isPhone(phone) || !isCode(code)) {
    return res.status(400).json(fail("invalid_payload", rid));
  }

  let redis;
  try {
    redis = getRedis();
  } catch {
    return res.status(503).json(fail("service_unavailable", rid));
  }
  const session = await readSession(phone);

  if (!session) {
    return res.status(400).json(fail("Invalid code", rid));
  }

  if (Date.now() > session.expiresAt) {
    await redis.del(sessionKey(phone));
    return res.status(410).json(fail("OTP expired", rid));
  }

  if (session.code !== code) {
    session.invalidAttempts += 1;
    if (session.invalidAttempts >= 5) {
      await redis.del(sessionKey(phone));
      return res.status(400).json(fail("Invalid code", rid));
    }
    await writeSession(phone, session);
    return res.status(400).json(fail("Invalid code", rid));
  }

  const { JWT_SECRET } = getEnv();
  if (!JWT_SECRET) {
    return res.status(401).json(fail("unauthorized", rid));
  }
  const token = jwt.sign(
    { phone },
    JWT_SECRET,
    { expiresIn: "1d" },
  );

  await redis.del(sessionKey(phone));

  return res.status(200).json(ok({ token }, rid));
});

export default router;
