import { Router } from "express";
import twilio from "twilio";

import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { signAccessToken } from "../auth/jwt.js";
import { ROLES, normalizeRole } from "../auth/roles.js";
import { isTest } from "../config/runtime.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { authMeHandler } from "./auth/me.js";
import { findAuthUserByPhone } from "../modules/auth/auth.repo.js";

const router = Router();

const isValidPhone = (phone: unknown): phone is string => typeof phone === "string" && phone.trim().length > 0;

type TwilioVerifyClient = {
  verify: {
    v2: {
      services: (serviceSid: string) => {
        verifications: {
          create: (params: { to: string; channel: "sms" }) => Promise<{ status: string }>;
        };
        verificationChecks: {
          create: (params: { to: string; code: string }) => Promise<{ status: string }>;
        };
      };
    };
  };
};

const getTwilioClient = (): TwilioVerifyClient => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? "";
  return twilio(accountSid, authToken) as unknown as TwilioVerifyClient;
};

// START OTP
router.post("/otp/start", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: "Phone is required" });
    }

    if (isTest) {
      const store = (globalThis.__otpStore ??= {});
      store[phone] = {
        code: "000000",
        createdAt: Date.now(),
        attempts: 0,
        verified: false,
      };

      return res.status(200).json({
        status: "ok",
        data: { sent: true },
      });
    }

    if (process.env.NODE_ENV !== "test" && !process.env.TWILIO_VERIFY_SERVICE_SID) {
      throw new Error("Missing Twilio Verify SID");
    }

    const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
    if (!serviceSid) {
      throw new Error("Missing Twilio Verify SID");
    }

    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(serviceSid)
      .verifications.create({
        to: phone,
        channel: "sms",
      });

    return res.status(200).json({
      status: "ok",
      data: { sent: true },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown OTP error";
    console.error("❌ OTP ERROR:", message);

    return res.status(500).json({
      error: "OTP failed",
    });
  }
});

// VERIFY OTP
router.post("/otp/verify", async (req, res) => {
  const { phone, code } = req.body;

  // Test mode — use in-memory store
  if (isTest) {
    const store = globalThis.__otpStore ?? {};
    const record = store[phone];
    if (!record || code !== "000000") {
      return res.status(401).json({ error: "Invalid code" });
    }
    record.verified = true;
    try {
      const token = signAccessToken({
        sub: `test-user:${phone}`,
        role: ROLES.STAFF,
        tokenVersion: 0,
        phone,
      });
      return res.status(200).json({ status: "ok", data: { token } });
    } catch {
      return res.status(500).json({ error: "auth not configured" });
    }
  }

  // Production
  if (!phone || !code) {
    return res.status(400).json({ error: "Phone and code are required" });
  }

  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!serviceSid) {
    return res.status(500).json({ error: "OTP failed" });
  }

  try {
    const twilioClient = getTwilioClient();

    const verificationCheck = await twilioClient.verify.v2
      .services(serviceSid)
      .verificationChecks.create({ to: phone, code });

    if (verificationCheck.status !== "approved") {
      return res.status(401).json({ error: "Invalid code" });
    }

    if (!process.env.JWT_SECRET) {
      return res.status(500).json({ error: "auth not configured" });
    }

    const user = await findAuthUserByPhone(phone);
    if (!user) {
      return res.status(403).json({
        status: "error",
        error: "no_account",
        message: "No staff account found for this phone number. Contact your administrator.",
      });
    }

    if (!user.role) {
      return res.status(403).json({
        status: "error",
        error: "no_role",
        message: "Account has no role assigned. Contact your administrator.",
      });
    }

    if (user.disabled || !user.active) {
      return res.status(403).json({ status: "error", error: "account_disabled" });
    }

    const role = normalizeRole(user.role ?? "") ?? ROLES.STAFF;
    const token = signAccessToken({
      sub: String(user.id),
      role,
      tokenVersion: user.tokenVersion ?? 0,
      phone: user.phoneNumber ?? phone,
      capabilities: fetchCapabilitiesForRole(role),
    });

    return res.status(200).json({ status: "ok", data: { token } });
  } catch (_err) {
    return res.status(401).json({ error: "Invalid code" });
  }
});

router.get("/me", requireAuth, authMeHandler);


export default router;

export function resetOtpStateForTests() {
  globalThis.__otpStore = {};
}
