import process from "node:process"
import { createRequire } from "node:module";
import { config } from "../config/index.js";

const require = createRequire(import.meta.url);

let client: any | null = null
let twilioFactory: any | null | undefined;

function fetchTwilioFactory(): any | null {
  if (twilioFactory !== undefined) {
    return twilioFactory;
  }

  try {
    const loaded = require("twilio");
    twilioFactory = loaded.default ?? loaded;
  } catch {
    twilioFactory = null;
  }

  return twilioFactory;
}

function isConfigured() {
  return !!(
    config.twilio.accountSid &&
    config.twilio.authToken &&
    config.twilio.verifyServiceSid
  )
}

function fetchClient() {
  if (!isConfigured()) {
    throw new Error("Missing required environment variable")
  }

  if (!client) {
    const twilioFactory = fetchTwilioFactory();
    if (!twilioFactory) {
      throw new Error("Twilio SDK unavailable");
    }
    client = twilioFactory(
      config.twilio.accountSid!,
      config.twilio.authToken!
    )
  }

  return client
}

export function fetchTwilioClient() {
  return fetchClient()
}

export function fetchVerifyServiceSid() {
  if (!config.twilio.verifyServiceSid) {
    throw new Error("Missing required environment variable")
  }

  return config.twilio.verifyServiceSid
}

export async function startVerification(phone: string) {
  const twilio = fetchClient()

  return twilio.verify.v2
    .services(fetchVerifyServiceSid())
    .verifications.create({
      to: phone,
      channel: "sms",
    })
}

export async function checkVerification(phone: string, code: string) {
  const twilio = fetchClient()

  return twilio.verify.v2
    .services(fetchVerifyServiceSid())
    .verificationChecks.create({
      to: phone,
      code,
    })
}

/**
 * Safe guard for tests / non-Twilio environments
 */
export function isTwilioAvailable() {
  return isConfigured()
}
