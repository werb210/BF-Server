"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.incomingCallHandler = incomingCallHandler;
const respond_1 = require("../../lib/respond");
const twilioModule = require("twilio");
function incomingCallHandler(_req, res) {
    const VoiceResponse = twilioModule.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const dial = response.dial();
    dial.client("staff");
    return (0, respond_1.ok)(res, response.toString());
}
