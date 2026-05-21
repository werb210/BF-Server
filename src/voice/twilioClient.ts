// BF_SERVER_BLOCK_v599 -- shared Twilio REST client + URL helpers
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const twilioLib = require("twilio");

export function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !tok) throw new Error("twilio_not_configured");
  return twilioLib(sid, tok);
}

export function getCallerId(): string {
  return process.env.TWILIO_CALLER_ID
    || process.env.TWILIO_DEFAULT_OUTBOUND_CALLER_ID
    || process.env.TWILIO_FROM_NUMBER
    || process.env.TWILIO_PHONE_NUMBER
    || "";
}

export function getBaseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "https://server.boreal.financial";
}

export default getTwilioClient;
