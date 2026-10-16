import { v4 as uuid } from "uuid";
import { createRequire } from "module";
import { config } from "../../config/index.js";

const require = createRequire(import.meta.url);
const twilio = require("twilio");

const { jwt } = twilio;
const AccessToken = jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

function requireTokenConfig(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required for voice token generation`);
  }
  return value;
}

// BF_SERVER_v815_VOIP_PUSH
export function pushCredentialGrant(env: NodeJS.ProcessEnv = process.env): { pushCredentialSid?: string } {
  const sid = String(env.TWILIO_PUSH_CREDENTIAL_SID ?? "").trim();
  return /^CR[0-9a-f]{32}$/i.test(sid) ? { pushCredentialSid: sid } : {};
}

export function generateVoiceToken(identity: string): string {
  const resolvedIdentity = identity?.trim().length ? identity : uuid();

  const token = new AccessToken(
    config.twilio.accountSid,
    requireTokenConfig(config.twilio.apiKey, "TWILIO_API_KEY"),
    requireTokenConfig(config.twilio.apiSecret, "TWILIO_API_SECRET"),
    {
      identity: resolvedIdentity,
      ttl: 14400, // BF_SERVER_VOICE_TOKEN_TTL_v1 4h; reduces AccessTokenExpired(20104) mid-session
    }
  );

  // BF_SERVER_v815_VOIP_PUSH - the iPhone dialer registers for incoming calls with this token. Twilio can only wake
  // a closed iPhone (VoIP push -> CallKit) when the token names the Push Credential made from the company Apple key
  // for com.borealfinancial.dialer. Unset = exactly as before (no push credential).
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: requireTokenConfig(config.twilio.voiceAppSid, "TWILIO_VOICE_APP_SID"),
    incomingAllow: true,
    ...pushCredentialGrant(),
  });

  token.addGrant(voiceGrant);

  return token.toJwt();
}
