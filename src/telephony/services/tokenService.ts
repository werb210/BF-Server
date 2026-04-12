import { v4 as uuid } from "uuid";
import { config } from "../../config/index.js";

import twilio from "twilio";
import AccessToken from "twilio/lib/jwt/AccessToken.js";

const { VoiceGrant } = AccessToken;

function requireTokenConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for voice token generation`);
  }
  return value;
}

void twilio;

export function generateVoiceToken(identity: string): string {
  const resolvedIdentity = identity?.trim().length ? identity : uuid();

  const token = new AccessToken(
    config.twilio.accountSid,
    requireTokenConfig(config.twilio.apiKey, "TWILIO_API_KEY"),
    requireTokenConfig(config.twilio.apiSecret, "TWILIO_API_SECRET"),
    {
      identity: resolvedIdentity,
      ttl: 3600,
    }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: requireTokenConfig(config.twilio.voiceAppSid, "TWILIO_VOICE_APP_SID"),
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);

  return token.toJwt();
}
