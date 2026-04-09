import express, { Router } from "express";
import twilio from "twilio";
import { twilioWebhookValidation } from "../middleware/twilioWebhookValidation.js";
import { ok } from "../lib/respond.js";
const router = Router();
const twilioRuntime = twilio;
router.post("/twilio/voice", express.urlencoded({ extended: false }), twilioWebhookValidation, (_req, res) => {
    const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const dial = response.dial({
        answerOnBridge: true,
        timeout: 20,
    });
    // Ring all staff endpoints simultaneously
    dial.client("staff_portal");
    dial.client("staff_mobile");
    return ok(res, response.toString());
});
export default router;
