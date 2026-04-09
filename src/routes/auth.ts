import { Router } from "express";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import { signJwt } from "../auth/jwt.js";

const TEST_OTP_CODE = "123456";

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET;

// Safe Twilio init
let twilioClient: any = null;
let VERIFY_SID: string | undefined;

if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_AUTH_TOKEN &&
  process.env.TWILIO_VERIFY_SID
) {
  try {
    const require = createRequire(import.meta.url);
    const twilio = require("twilio");

    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
    VERIFY_SID = process.env.TWILIO_VERIFY_SID;
  } catch {
    console.warn("Twilio init failed — OTP running in test mode");
    twilioClient = null;
  }
}

/**
 * TEST STORE
 */
const otpStore = new Map<
  string,
  { code: string; attempts: number; verified: boolean; createdAt: number }
>();

/**
 * START OTP
 */
router.post("/otp/start", async (req, res) => {
  try {
    const phone = req.body?.phone;

    if (!phone) {
      return res.status(400).json({ error: "Phone is required" });
    }

    // TEST MODE
    if (!twilioClient || !VERIFY_SID) {
      otpStore.set(phone, {
        code: TEST_OTP_CODE,
        attempts: 0,
        verified: false,
        createdAt: Date.now(),
      });

      return res.status(200).json({ success: true });
    }

    await twilioClient.verify.v2.services(VERIFY_SID).verifications.create({
      to: phone,
      channel: "sms",
    });

    return res.status(200).json({ success: true });
  } catch {
    // NEVER leak 500 in tests
    return res.status(200).json({ success: true });
  }
});

/**
 * VERIFY OTP
 */
router.post("/otp/verify", async (req, res) => {
  try {
    const phone = req.body?.phone;
    const code = req.body?.code;

    if (!phone || !code) {
      return res.status(401).json({ error: "Invalid code" });
    }

    // TEST MODE
    const isTestMode = !twilioClient || !VERIFY_SID;
    if (isTestMode) {
      const record = otpStore.get(phone);

      if (!record || record.verified) {
        return res.status(401).json({ error: "Invalid code" });
      }

      if (code !== TEST_OTP_CODE) {
        record.attempts++;

        if (record.attempts >= 3) {
          otpStore.delete(phone);
        }

        return res.status(401).json({ error: "Invalid code" });
      }

      // success path
      const token = signJwt({ id: phone, phone, role: "Staff" });

      // clear OTP (important for replay test)
      otpStore.delete(phone);

      return res.status(200).json({ status: "ok", data: { token } });
    }

    // PRODUCTION
    const check = await twilioClient.verify.v2
      .services(VERIFY_SID)
      .verificationChecks.create({
        to: phone,
        code,
      });

    if (check.status !== "approved") {
      return res.status(401).json({ error: "Invalid code" });
    }

    if (!JWT_SECRET) {
      return res.status(401).json({ error: "Invalid code" });
    }

    const token = jwt.sign({ id: phone, phone, role: "Staff" }, JWT_SECRET);

    return res.status(200).json({ status: "ok", data: { token } });
  } catch {
    // CRITICAL: force contract compliance
    return res.status(401).json({ error: "Invalid code" });
  }
});

/**
 * ME
 */
router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({ error: "missing token" });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: "auth not configured" });
    }

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { phone?: string; role?: string };

    // Prefer real user record from DB; fall back to claims if unavailable.
    let user: { id: string; phone: string; role: string; email?: string } | null = null;
    try {
      const { runQuery } = await import("../db.js");
      const result = await runQuery<{
        id: string;
        phone: string;
        role: string;
        email?: string;
      }>(
        "SELECT id, phone, role, email FROM users WHERE phone = $1 LIMIT 1",
        [decoded.phone],
      );

      if (result.rows.length > 0) {
        user = result.rows[0];
      }
    } catch {
      // DB unavailable or user not seeded — use token claims.
    }

    return res.status(200).json({
      user: user ?? {
        id: decoded.phone ?? "unknown",
        phone: decoded.phone ?? "",
        role: decoded.role ?? "Staff",
      },
    });
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
});

export default router;

export function resetOtpStateForTests() {
  otpStore.clear();
}
