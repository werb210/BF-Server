import express from "express";
import VoiceResponse from "twilio/lib/twiml/VoiceResponse";
import { requireAuth } from "../middleware/requireAuth.js";
import { validate } from "../middleware/validate.js";
import { CallStatusSchema } from "../schemas/index.js";
import { ok as respondOk } from "../lib/respond.js";
const router = express.Router();
router.post("/incoming", (_req, res) => {
    const voiceResponse = new VoiceResponse();
    voiceResponse.say("Connecting you to Maya.");
    voiceResponse.dial().client("maya-agent");
    return respondOk(res, voiceResponse.toString());
});
router.post("/status", requireAuth, validate(CallStatusSchema), (req, res) => {
    return respondOk(res, { received: true });
});
export default router;
