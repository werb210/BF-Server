import { Router } from "express";
import rateLimit from "express-rate-limit";
import { twilioClient, twilioEnabled, verifyServiceSid } from "../lib/twilioClient";
import { ok, fail } from "../middleware/response";

const router = Router();

const sendLimiter = rateLimit({ windowMs: 60 * 1000, max: 3 });
const verifyLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// SEND OTP (Twilio Verify ONLY)
router.post("/send-otp", sendLimiter, async (req, res) => {
  const { phone } = req.body;

  if (!phone) return fail(res, 400, "phone_required");
  if (!twilioEnabled || !twilioClient) {
    return fail(res, 503, "twilio_not_configured");
  }

  try {
    const verification = await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phone, channel: "sms" });

    return ok(res, { status: verification.status });
  } catch (_err) {
    return fail(res, 500, "twilio_verify_failure");
  }
});

// VERIFY OTP (Twilio Verify ONLY)
router.post("/verify-otp", verifyLimiter, async (req, res) => {
  const { phone, code } = req.body;

  if (!phone || !code) {
    return fail(res, 400, "phone_and_code_required");
  }
  if (!twilioEnabled || !twilioClient) {
    return fail(res, 503, "twilio_not_configured");
  }

  try {
    const check = await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== "approved") {
      return fail(res, 401, "otp_invalid");
    }

    return ok(res, { verified: true });
  } catch (_err) {
    return fail(res, 500, "twilio_verify_failure");
  }
});

export default router;
