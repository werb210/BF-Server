import { Router } from "express";
import twilio from "twilio";
import { config } from "../config/index.js";
import { ok } from "../lib/respond.js";
const router = Router();
const twilioRuntime = twilio;
router.post("/voice/incoming", (_req, res) => {
    const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    const dial = twiml.dial({
        timeout: 20,
        callerId: config.twilio.phoneNumber,
        statusCallback: "/api/voice/status",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
    });
    dial.client("staff_portal");
    dial.client("staff_mobile");
    return ok(res, twiml.toString());
});
export default router;
