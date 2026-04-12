import { Router } from "express";
import { createRequire } from "module";
import { requireAuth } from "../middleware/auth.js";
import { config } from "../config/index.js";

const require = createRequire(import.meta.url);
const twilio = require("twilio");

const { jwt } = twilio;
const AccessToken = jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

const router = Router();

function issueToken(req: any, res: any) {
  try {
    if (!config.twilio.accountSid) {
      return res.status(500).json({ error: "Twilio not configured" });
    }

    const identity = req.user?.id || req.user?.userId || "anonymous";

    const token = new AccessToken(
      config.twilio.accountSid,
      config.twilio.apiKey,
      config.twilio.apiSecret,
      { identity }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: config.twilio.voiceAppSid,
      incomingAllow: true,
    });

    token.addGrant(voiceGrant);

    res.json({
      token: token.toJwt(),
    });
  } catch {
    res.status(500).json({ error: "Failed to generate token" });
  }
}

router.get("/voice/token", requireAuth, issueToken);
router.post("/voice/token", requireAuth, issueToken);

export default router;
