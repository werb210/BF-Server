import AccessToken, { VoiceGrant } from "twilio/lib/jwt/AccessToken";

export function generateVoiceToken(identity: string): string {
  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID!,
    process.env.TWILIO_API_KEY!,
    process.env.TWILIO_API_SECRET!,
    { identity }
  );

  const grant = new VoiceGrant({
    outgoingApplicationSid:
      process.env.TWILIO_VOICE_APP_SID!,
    incomingAllow: true,
  });

  token.addGrant(grant);

  return token.toJwt();
}
