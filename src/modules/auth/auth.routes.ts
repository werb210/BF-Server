import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { otpStore } from "./otpStore";
import { ok } from "../../middleware/response";

const router = Router();

const TEST_OTP_CODE = process.env.TEST_OTP_CODE || "654321";

const error = (res: Response, status: number, message: string) =>
  res.status(status).json({ success: false, error: message });

export function resetOtpStateForTests() {
  otpStore.clear();
}

router.post("/otp/start", (req: Request, res: Response) => {
  const { phone } = req.body as { phone?: string };

  if (!phone || typeof phone !== "string" || !/^\+?\d{7,15}$/.test(phone)) {
    return error(res, 400, "invalid_payload");
  }

  const existing = otpStore.get(phone);
  const now = Date.now();

  if (existing && now - existing.lastSentAt < 60_000) {
    return error(res, 429, "Too many requests");
  }

  const code = process.env.NODE_ENV === "test"
    ? TEST_OTP_CODE
    : Math.floor(100000 + Math.random() * 900000).toString();

  otpStore.set(phone, {
    code,
    expiresAt: now + 5 * 60 * 1000,
    attempts: 0,
    lastSentAt: now,
    used: false,
  });

  return ok(res, { sent: true });
});

router.post("/otp/verify", (req: Request, res: Response) => {
  const { phone, code } = req.body as { phone?: string; code?: string };

  if (
    !phone
    || !code
    || typeof phone !== "string"
    || typeof code !== "string"
    || !/^\+?\d{7,15}$/.test(phone)
    || !/^\d{6}$/.test(code)
  ) {
    return error(res, 400, "invalid_payload");
  }

  if (!process.env.JWT_SECRET) {
    return error(res, 401, "unauthorized");
  }

  const record = otpStore.get(phone);

  if (!record) {
    return error(res, 400, "Invalid code");
  }

  const now = Date.now();

  if (now > record.expiresAt) {
    otpStore.delete(phone);
    return error(res, 410, "OTP expired");
  }

  if (record.used) {
    return error(res, 400, "Invalid code");
  }

  if (record.code !== code) {
    record.attempts += 1;

    if (record.attempts >= 5) {
      otpStore.delete(phone);
    } else {
      otpStore.set(phone, record);
    }

    return error(res, 400, "Invalid code");
  }

  record.used = true;
  otpStore.set(phone, record);

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    return error(res, 401, "unauthorized");
  }

  const token = jwt.sign({ phone }, jwtSecret, { expiresIn: "1d" });

  return ok(res, { token });
});

export default router;
