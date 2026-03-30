"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateVoiceToken = generateVoiceToken;
const uuid_1 = require("uuid");
const config_1 = require("../../config");
const twilioModule = require("twilio");
const AccessToken = twilioModule.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;
function requireTokenConfig(value, name) {
    if (!value) {
        throw new Error(`${name} is required for voice token generation`);
    }
    return value;
}
function generateVoiceToken(identity) {
    const resolvedIdentity = identity?.trim().length ? identity : (0, uuid_1.v4)();
    const token = new AccessToken(config_1.config.twilio.accountSid, requireTokenConfig(config_1.config.twilio.apiKey, "TWILIO_API_KEY"), requireTokenConfig(config_1.config.twilio.apiSecret, "TWILIO_API_SECRET"), {
        identity: resolvedIdentity,
        ttl: 3600,
    });
    const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: requireTokenConfig(config_1.config.twilio.voiceAppSid, "TWILIO_VOICE_APP_SID"),
        incomingAllow: true,
    });
    token.addGrant(voiceGrant);
    return token.toJwt();
}
