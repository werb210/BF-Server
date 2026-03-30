"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const twilio_1 = __importDefault(require("twilio"));
const config_1 = require("../config");
const router = (0, express_1.Router)();
const twilioRuntime = twilio_1.default;
router.post("/voice/incoming", (_req, res) => {
    const VoiceResponse = twilioRuntime.twiml.VoiceResponse;
    const twiml = new VoiceResponse();
    const dial = twiml.dial({
        timeout: 20,
        callerId: config_1.config.twilio.phoneNumber,
        statusCallback: "/api/voice/status",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
    });
    dial.client("staff_portal");
    dial.client("staff_mobile");
    res.type("text/xml");
    res.send(twiml.toString());
});
exports.default = router;
