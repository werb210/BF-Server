"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.twilioClient = exports.twilioVoiceGrantConfig = void 0;
const twilioClient_1 = require("../../platform/twilioClient");
Object.defineProperty(exports, "twilioClient", { enumerable: true, get: function () { return twilioClient_1.twilioClient; } });
const config_1 = require("../../config");
exports.twilioVoiceGrantConfig = {
    outgoingApplicationSid: config_1.config.twilio.voiceAppSid,
    incomingAllow: true,
};
exports.default = twilioClient_1.twilioClient;
