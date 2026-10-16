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
// BF_SERVER_v817_IPAD_VOIP - which native app the token is for. Each app has its own Twilio Push Credential (its own
// bundle id): "dialer" (iPhone dialer, com.borealfinancial.dialer) reads TWILIO_PUSH_CREDENTIAL_SID; "portal-ios"
// (staff portal iPad app, com.borealfinancial.portal) reads TWILIO_PUSH_CREDENTIAL_SID_PORTAL. Anything else = dialer.
export type VoiceTokenApp = "dialer" | "portal-ios";

// BF_SERVER_v817_IPAD_VOIP - "portal_ipad" is accepted as an alias of "portal-ios" (earlier spelling).
export function parseVoiceTokenApp(raw: unknown): VoiceTokenApp {
  const v = String(Array.isArray(raw) ? raw[0] : raw ?? "").trim().toLowerCase();
  return v === "portal-ios" || v === "portal_ipad" ? "portal-ios" : "dialer";
}

export function pushCredentialGrant(
  env: NodeJS.ProcessEnv = process.env,
  app: VoiceTokenApp = "dialer",
): { pushCredentialSid?: string } {
  const raw = app === "portal-ios" ? env.TWILIO_PUSH_CREDENTIAL_SID_PORTAL : env.TWILIO_PUSH_CREDENTIAL_SID;
  const sid = String(raw ?? "").trim();
  return /^CR[0-9a-f]{32}$/i.test(sid) ? { pushCredentialSid: sid } : {};
}

// BF_SERVER_v817_IPAD_VOIP - same identity for every app: Twilio delivers an incoming <Client> call to every device
// registered under the identity, so the IVR rings the iPhone dialer and the iPad portal together.
export function generateVoiceToken(identity: string, opts: { app?: VoiceTokenApp } = {}): string {
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
    ...pushCredentialGrant(process.env, opts.app ?? "dialer"),
  });

  token.addGrant(voiceGrant);

  return token.toJwt();
}
