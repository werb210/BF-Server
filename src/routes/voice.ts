import express from "express";
import twilio from "twilio";

const VoiceResponse = twilio.twiml.VoiceResponse;
import { ok as respondOk } from "../lib/respond.js";

const router = express.Router();

router.post("/incoming", (_req, res) => {
  const voiceResponse = new VoiceResponse();

  voiceResponse.say("Connecting you to Maya.");
  voiceResponse.dial().client("maya-agent");

  return respondOk(res, voiceResponse.toString());
});

// BF_SERVER_v784_VOICE_STATUS - POST /status moved to the mounted voiceCalls.ts.

export default router;
