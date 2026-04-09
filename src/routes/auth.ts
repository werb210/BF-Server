import { Router } from "express";
import jwt from "jsonwebtoken";
import twilio from "twilio";

const router = Router();

function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    return null;
  }

  return twilio(accountSid, authToken);
}

function getRequiredSecrets() {
  const verifySid = process.env.TWILIO_VERIFY_SID;
  const jwtSecret = process.env.JWT_SECRET;

  if (!verifySid || !jwtSecret) {
    return null;
  }

  return {
    verifySid,
    jwtSecret,
  };
}

// START OTP
router.post("/otp/start", async (req, res) => {
  try {
    const { phone } = req.body as { phone?: string };

    if (!phone) {
      return res.status(400).json({ error: "phone required" });
    }

    const client = getTwilioClient();
    const secrets = getRequiredSecrets();

    if (!client || !secrets) {
      return res.status(500).json({ error: "auth provider not configured" });
    }

    await client.verify.v2.services(secrets.verifySid).verifications.create({
      to: phone,
      channel: "sms",
    });

    return res.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "otp start failed";
    return res.status(500).json({ error: message });
  }
});

// VERIFY OTP
router.post("/otp/verify", async (req, res) => {
  try {
    const { phone, code } = req.body as { phone?: string; code?: string };

    if (!phone || !code) {
      return res.status(400).json({ error: "phone + code required" });
    }

    const client = getTwilioClient();
    const secrets = getRequiredSecrets();

    if (!client || !secrets) {
      return res.status(500).json({ error: "auth provider not configured" });
    }

    const check = await client.verify.v2.services(secrets.verifySid).verificationChecks.create({
      to: phone,
      code,
    });

    if (check.status !== "approved") {
      return res.status(401).json({ error: "invalid code" });
    }

    const token = jwt.sign({ phone }, secrets.jwtSecret, { expiresIn: "7d" });

    return res.json({ token });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "otp verify failed";
    return res.status(500).json({ error: message });
  }
});

// GET CURRENT USER
router.get("/me", (req, res) => {
  try {
    const auth = req.headers.authorization;

    if (!auth) {
      return res.status(401).json({ error: "missing token" });
    }

    const token = auth.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "missing token" });
    }

    const secrets = getRequiredSecrets();

    if (!secrets) {
      return res.status(500).json({ error: "auth provider not configured" });
    }

    const decoded = jwt.verify(token, secrets.jwtSecret);

    return res.json({ user: decoded });
  } catch {
    return res.status(401).json({ error: "invalid token" });
  }
});

export default router;
