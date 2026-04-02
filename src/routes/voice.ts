import express from "express";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse";
import { requireAuth } from "../middleware/requireAuth";
import { validate } from "../middleware/validate";
import { CallStatusSchema } from "../schemas";
import { ok } from "../lib/response";

const router = express.Router();

router.post("/incoming", (_req, res) => {
  const voiceResponse = new VoiceResponse();

  voiceResponse.say("Connecting you to Maya.");
  voiceResponse.dial().client("maya-agent");

  res.type("text/xml");
  return res.json(voiceResponse.toString());
});

router.post("/status", requireAuth, validate(CallStatusSchema), (req, res) => {
  return res.json(ok({ received: true }, (req as any).rid));
});

export default router;
