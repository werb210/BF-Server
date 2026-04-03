import { Router } from "express";
import rateLimit from "express-rate-limit";

import { requireAuth } from "../middleware/auth";
import { twilioClient, twilioEnabled, verifyServiceSid } from "../lib/twilioClient";
import { fail, ok } from "../lib/response";

const router = Router();

const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 3 });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

export function resetOtpStateForTests() {
  // Twilio Verify owns OTP state in production; nothing to clear in process.
}

router.post("/send-otp", sendLimiter, async (req, res) => {
  const { phone } = req.body;

  if (!phone) return fail(res, "phone_required");
  if (!twilioEnabled || !twilioClient) {
    return fail(res, "twilio_not_configured", 503);
  }

  try {
    const verification = await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phone, channel: "sms" });

    return ok(res, { status: verification.status });
  } catch (_err) {
    return fail(res, "twilio_verify_failure", 500);
  }
});

router.post("/verify-otp", verifyLimiter, async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return fail(res, "phone_and_code_required");
  }
  if (!twilioEnabled || !twilioClient) {
    return fail(res, "twilio_not_configured", 503);
  }

  try {
    const check = await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== "approved") {
      return fail(res, "otp_invalid", 401);
    }

    return ok(res, { verified: true });
  } catch (_err) {
    return fail(res, "twilio_verify_failure", 500);
  }
});

router.get("/me", requireAuth, (req, res) => {
  return ok(res, { user: req.user ?? null });
});

router.post("/logout", (_req, res) => {
  return ok(res, { loggedOut: true });
});

export default router;
