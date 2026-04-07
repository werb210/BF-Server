"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.incomingCallHandler = incomingCallHandler;
const response_1 = require("../../lib/response");
const twilioModule = require("twilio");
function incomingCallHandler(req, res) {
    const VoiceResponse = twilioModule.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const dial = response.dial();
    dial.client("staff");
    res.json((0, response_1.ok)(response.toString(), req.rid));
    return;
}
