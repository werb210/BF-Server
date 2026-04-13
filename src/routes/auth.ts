import { Router } from "express";
import jwt from "jsonwebtoken";
import twilio from "twilio";

import { isTest } from "../config/runtime.js";

const router = Router();

const isValidPhone = (phone: unknown): phone is string => typeof phone === "string" && phone.trim().length > 0;

const getTwilioClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  return twilio(accountSid, authToken) as any;
};

// START OTP
router.post("/otp/start", async (req, res) => {
  console.log("🔥 OTP START HIT");

  try {
    const { phone } = req.body;

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Phone is required" });
    }

    if (isTest) {
      const store = (globalThis.__otpStore ??= {});
      store[phone] = {
        code: "654321",
        createdAt: Date.now(),
        attempts: 0,
      };

      return res.status(200).json({
        status: "ok",
        data: { sent: true },
      });
    }

    if (process.env.NODE_ENV !== "test" && !process.env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error("Missing Twilio Verify SID");
    }

    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verifications.create({
        to: phone,
        channel: "sms",
      });

    return res.status(200).json({
      success: true,
      status: verification.status,
    });
  } catch (err: any) {
    console.error("❌ OTP ERROR:", err.message);

    return res.status(500).json({
      error: "OTP failed",
    });
  }
});

// VERIFY OTP
router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body;

  const store = globalThis.__otpStore ?? {};
  const record = store[phone];

  if (isTest) {
    if (!record || code !== "654321") {
      return res.status(401).json({ error: "Invalid code" });
    }

    record.verified = true;

    return res.status(200).json({
      status: "ok",
      data: {
        token: "test-token",
      },
    });
  }

  if (!phone || !code) {
    return res.status(400).json({ error: "Phone and code are required" });
  }

  if (!process.env.TWILIO_VERIFY_SERVICE_SID) {
    return res.status(500).json({ error: "OTP failed" });
  }

  try {
    const client = getTwilioClient();
    const verificationCheck = await client.verify.v2
      .services(process.env.TWILIO_VERIFY_SERVICE_SID)
      .verificationChecks.create({
        to: phone,
        code,
      });

    if (verificationCheck.status !== "approved") {
      return res.status(401).json({ error: "Invalid code" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "auth not configured" });
    }

    const token = jwt.sign(
      {
        phone,
        role: "Staff",
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" },
    );

    return res.status(200).json({
      status: "ok",
      data: { token },
    });
  } catch (_err) {
    return res.status(401).json({ error: "Invalid code" });
  }
});

router.get("/me", async (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({ error: "missing token" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "auth not configured" });
    }

    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET) as { phone?: string; role?: string };

    return res.status(200).json({
      user: {
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
  globalThis.__otpStore = {};
}
