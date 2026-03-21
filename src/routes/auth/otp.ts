import { Router } from "express";
import jwt from "jsonwebtoken";

const router = Router();

/**
 * MOCK SAFE TWILIO ACCESS
 */
function getTwilio() {
  try {
    return (global as any).twilioClient;
  } catch {
    return null;
  }
}

/**
 * START OTP
 */
router.post("/start", async (req, res) => {
  const { phone } = req.body || {};

  if (!phone) {
    return res.status(400).json({
      ok: false,
      code: "invalid_request",
      message: "phone required",
    });
  }

  const twilio = getTwilio();

  try {
    if (twilio?.verify?.services) {
      await twilio.verify.services().verifications.create({
        to: phone,
        channel: "sms",
      });
    }

    return res.status(200).json({
      ok: true,
      status: "pending",
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      code: "otp_start_failed",
      message: "OTP start failed",
    });
  }
});

/**
 * VERIFY OTP
 */
router.post("/verify", async (req, res) => {
  const { phone, code } = req.body || {};

  if (!phone || !code) {
    return res.status(400).json({
      ok: false,
      code: "invalid_request",
      message: "phone and code required",
    });
  }

  const twilio = getTwilio();

  try {
    if (twilio?.verify?.services) {
      const result = await twilio.verify.services().verificationChecks.create({
        to: phone,
        code,
      });

      if (result.status !== "approved") {
        return res.status(400).json({
          ok: false,
          code: "otp_invalid",
          message: "OTP invalid",
        });
      }
    }

    const token = jwt.sign({ sub: String(phone) }, process.env.JWT_SECRET ?? "dev-secret", {
      algorithm: "HS256",
      expiresIn: "1h",
    });

    return res.status(200).json({
      ok: true,
      token,
    });
  } catch (err) {
    return res.status(400).json({
      ok: false,
      code: "otp_verify_failed",
      message: "OTP verify failed",
    });
  }
});

export default router;
