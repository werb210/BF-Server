import express from "express";
import twilio from "twilio";

const router = express.Router();

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

router.get("/api/voice/token", (req, res) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKey = process.env.TWILIO_API_KEY;
    const apiSecret = process.env.TWILIO_API_SECRET;
    const appSid = process.env.TWILIO_APP_SID;

    if (!accountSid || !apiKey || !apiSecret || !appSid) {
      return res.status(500).json({ error: "Missing Twilio config" });
    }

    const identity = "user-" + Date.now();

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
    });

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: appSid,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);

    res.json({ token: token.toJwt() });
  } catch (err) {
    console.error("Twilio token error:", err);
    res.status(500).json({ error: "Token generation failed" });
  }
});

export default router;
