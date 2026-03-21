import process from "node:process"
import Twilio from "twilio"

let client: any | null = null

function isConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_VERIFY_SERVICE_SID
  )
}

function getClient() {
  if (!isConfigured()) {
    throw new Error("Missing required environment variable")
  }

  if (!client) {
    client = Twilio(
      process.env.TWILIO_ACCOUNT_SID!,
      process.env.TWILIO_AUTH_TOKEN!
    )
  }

  return client
}

export function getTwilioClient() {
  return getClient()
}

export function getVerifyServiceSid() {
  if (!process.env.TWILIO_VERIFY_SERVICE_SID) {
    throw new Error("Missing required environment variable")
  }

  return process.env.TWILIO_VERIFY_SERVICE_SID
}

export async function startVerification(phone: string) {
  const twilio = getClient()

  return twilio.verify.v2
    .services(getVerifyServiceSid())
    .verifications.create({
      to: phone,
      channel: "sms",
    })
}

export async function checkVerification(phone: string, code: string) {
  const twilio = getClient()

  return twilio.verify.v2
    .services(getVerifyServiceSid())
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
