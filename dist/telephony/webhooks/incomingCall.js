"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.incomingCallHandler = incomingCallHandler;
const twilioModule = require("twilio");
function incomingCallHandler(_req, res) {
    const VoiceResponse = twilioModule.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const dial = response.dial();
    dial.client("staff");
    res.type("text/xml");
    res.send(response.toString());
}
