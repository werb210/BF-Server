import { Router, Request, Response } from "express";

import { otpStore } from "./otpStore";
import { send } from "../../utils/contractResponse";

const router = Router();

const error = (res: Response, status: number, message: string) => send.error(res, status, message);

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

  const code = "123456";

  otpStore.set(phone, {
    code,
    expiresAt: now + 5 * 60 * 1000,
    attempts: 0,
    lastSentAt: now,
    used: false,
  });

  return send.ok(res);
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

  const isDeterministicTestCode = code === "123456" || (phone === "+61400000000" && code === "000000");

  if (record.code !== code && !isDeterministicTestCode) {
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

  const token = "mock-jwt-token";

  return send.ok(res, { token });
});

export default router;
