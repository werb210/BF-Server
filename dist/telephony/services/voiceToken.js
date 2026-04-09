import AccessToken, { VoiceGrant } from "twilio/lib/jwt/AccessToken";
import { config } from "../../config/index.js";
function requireTokenConfig(value, name) {
    if (!value) {
        throw new Error(`${name} is required for voice token generation`);
    }
    return value;
}
export function generateVoiceToken(identity) {
    const token = new AccessToken(config.twilio.accountSid, requireTokenConfig(config.twilio.apiKey, "TWILIO_API_KEY"), requireTokenConfig(config.twilio.apiSecret, "TWILIO_API_SECRET"), { identity });
    const grant = new VoiceGrant({
        outgoingApplicationSid: requireTokenConfig(config.twilio.voiceAppSid, "TWILIO_VOICE_APP_SID"),
        incomingAllow: true,
    });
    token.addGrant(grant);
    return token.toJwt();
}
