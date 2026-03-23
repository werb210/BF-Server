import process from "node:process";
import Twilio from "twilio";

let cachedTwilioClient: any | null = null;

function isConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_VERIFY_SERVICE_SID
  );
}

function ensureTwilioClient() {
  if (!isConfigured()) {
    throw new Error("Missing required environment variable");
  }

  if (!cachedTwilioClient) {
    cachedTwilioClient = Twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    );
  }

  return cachedTwilioClient;
}

function ensureVerifyServiceSid() {
  if (!process.env.TWILIO_VERIFY_SERVICE_SID) {
    throw new Error("Missing required environment variable");
  }

  return process.env.TWILIO_VERIFY_SERVICE_SID;
}

export const twilioClient = ensureTwilioClient;
export const verifyServiceSid = ensureVerifyServiceSid;

export async function startVerification(phone: string) {
  const twilio = ensureTwilioClient();

  return twilio.verify.v2
    .services(ensureVerifyServiceSid())
    .verifications.create({
      to: phone,
      channel: "sms",
    });
}

export async function checkVerification(phone: string, code: string) {
  const twilio = ensureTwilioClient();

  return twilio.verify.v2
    .services(ensureVerifyServiceSid())
    .verificationChecks.create({
      to: phone,
      code,
    });
}

/**
 * Safe guard for tests / non-Twilio environments
 */
export function isTwilioAvailable() {
  return isConfigured();
}
