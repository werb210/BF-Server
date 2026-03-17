import { v4 as uuid } from "uuid";

const twilioModule = require("twilio") as any;
const AccessToken = twilioModule.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

export function generateVoiceToken(identity: string): string {
  const resolvedIdentity = identity?.trim().length ? identity : uuid();

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    {
      identity: resolvedIdentity,
      ttl: 3600,
    }
  );

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid:
      process.env.TWILIO_VOICE_APP_SID ?? process.env.TWILIO_TWIML_APP_SID!,
    incomingAllow: true,
  });

  token.addGrant(voiceGrant);

  return token.toJwt();
}
