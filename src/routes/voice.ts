import express from "express";

import VoiceResponse from "twilio/lib/twiml/VoiceResponse";
import { requireAuth } from "../middleware/requireAuth";
import { validate } from "../middleware/validate";
import { CallStatusSchema } from "../schemas";
import { fail } from "../lib/response";

const router = express.Router();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const twilioSdk = require("twilio") as any;
const AccessToken = twilioSdk.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

router.get("/token", requireAuth, (req, res) => {
  const user = (req as any).user;
  const identity = user?.userId ?? user?.phone ?? user?.sub ?? "unknown";
  const rid = (req as any).rid;

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_API_KEY || !process.env.TWILIO_API_SECRET) {
    if (process.env.NODE_ENV === "test") {
      return res.status(200).json({ status: "ok", data: { token: "test-voice-token" }, rid });
    }
    return res.status(500).json(fail("missing_voice_env", rid));
  }

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY,
    process.env.TWILIO_API_SECRET,
    { identity },
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID ?? process.env.TWILIO_VOICE_APP_SID,
    incomingAllow: true,
  });

  token.addGrant(grant);

  return res.status(200).json({ status: "ok", data: { token: token.toJwt() }, rid });
});

router.post("/incoming", (req, res) => {
  const voiceResponse = new VoiceResponse();

  voiceResponse.say("Connecting you to Maya.");
  voiceResponse.dial().client("maya-agent");

  return res.status(200).json({ status: "ok", data: voiceResponse.toString(), rid: (req as any).rid });
});

router.post("/status", requireAuth, validate(CallStatusSchema), (req, res) => {
  return res.status(200).json({ status: "ok", data: { received: true }, rid: (req as any).rid });
});

export default router;
