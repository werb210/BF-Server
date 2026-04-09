import { Router } from "express";
import jwt from "jsonwebtoken";

let twilioClient: any = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const twilio = require("twilio");
  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN
  ) {
    twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }
} catch {}

const VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const JWT_SECRET = process.env.JWT_SECRET;

const router = Router();

/**
 * TEST MODE FALLBACK STORE
 */
const otpStore = new Map<
  string,
  { code: string; attempts: number; verified: boolean }
>();

/**
 * START OTP
 */
router.post("/otp/start", async (req, res) => {
  try {
    const { phone } = req.body || {};

    if (!phone) {
      return res.status(400).json({ error: "Phone is required" });
    }

    // TEST MODE (NO TWILIO)
    if (!twilioClient || !VERIFY_SID) {
      otpStore.set(phone, {
        code: "654321",
        attempts: 0,
        verified: false,
      });

      return res.status(200).json({ success: true });
    }

    await twilioClient.verify.v2.services(VERIFY_SID).verifications.create({
      to: phone,
      channel: "sms",
    });

    return res.status(200).json({ success: true });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * VERIFY OTP
 */
router.post("/otp/verify", async (req, res) => {
  try {
    const { phone, code } = req.body || {};

    if (!phone || !code) {
      return res.status(401).json({ error: "Invalid code" });
    }

    // TEST MODE
    if (!twilioClient || !VERIFY_SID) {
      const record = otpStore.get(phone);

      if (!record) {
        return res.status(401).json({ error: "Invalid code" });
      }

      if (record.verified) {
        return res.status(401).json({ error: "Invalid code" });
      }

      if (record.code !== code) {
        record.attempts += 1;

        if (record.attempts >= 3) {
          otpStore.delete(phone);
        }

        return res.status(401).json({ error: "Invalid code" });
      }

      record.verified = true;

      if (!JWT_SECRET) {
        return res.status(401).json({ error: "Invalid code" });
      }

      const token = jwt.sign({ phone }, JWT_SECRET);

      return res.status(200).json({ token });
    }

    // PRODUCTION (TWILIO)
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

    const token = jwt.sign({ phone }, JWT_SECRET);

    return res.status(200).json({ token });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * CURRENT USER
 */
router.get("/me", (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({ error: "missing token" });
    }

    const token = auth.split(" ")[1];

    const decoded = jwt.verify(token, JWT_SECRET || "fallback");

    return res.status(200).json({ user: decoded });
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
});

export default router;
