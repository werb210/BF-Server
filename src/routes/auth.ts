import { Router } from "express";
import rateLimit from "express-rate-limit";

import { twilioClient } from "../lib/twilioClient";

const router = Router();

const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID;
if (!verifyServiceSid) {
  throw new Error("Missing TWILIO_VERIFY_SERVICE_SID");
}

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
});

const checkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
});

router.post("/send-otp", sendLimiter, async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) {
      return res.status(400).json({ error: "phone required" });
    }

    const verification = await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verifications.create({ to: phone, channel: "sms" });

    return res.json({ status: verification.status });
  } catch (error) {
    return next(error);
  }
});

router.post("/verify-otp", checkLimiter, async (req, res, next) => {
  try {
    const { phone, code } = req.body;
    if (!phone || !code) {
      return res.status(400).json({ error: "phone and code required" });
    }

    const check = await twilioClient.verify.v2
      .services(verifyServiceSid)
      .verificationChecks.create({ to: phone, code });

    if (check.status !== "approved") {
      return res.status(401).json({ error: "invalid code" });
    }

    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
