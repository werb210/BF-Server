import jwt from "jsonwebtoken";
import { Router } from "express";

const router = Router();
const OTP_TTL_MS = 5 * 60 * 1000;

type OtpRecord = {
  code: string;
  phone: string;
  createdAt: number;
};

const otpStore: Record<string, OtpRecord> = {};

function isPhone(value: unknown): value is string {
  return typeof value === "string" && /^\+?[1-9]\d{7,14}$/.test(value.trim());
}

function isCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value.trim());
}

router.post("/otp/start", (req, res) => {
  const { phone } = req.body as { phone?: unknown };

  if (!isPhone(phone)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  otpStore[phone] = {
    code: "123456",
    phone,
    createdAt: Date.now(),
  };

  res.status(200).json({ ok: true });
});

router.post("/otp/verify", (req, res) => {
  const { phone, code } = req.body as { phone?: unknown; code?: unknown };

  if (!isPhone(phone) || !isCode(code)) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const otpRecord = otpStore[phone];
  const now = Date.now();

  if (!otpRecord) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  if (now - otpRecord.createdAt > OTP_TTL_MS) {
    delete otpStore[phone];
    res.status(410).json({ error: "OTP expired" });
    return;
  }

  if (otpRecord.code !== code) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  delete otpStore[phone];

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const token = jwt.sign({ phone }, jwtSecret, { expiresIn: "7d" });
  res.status(200).json({ ok: true, token });
});

export default router;
