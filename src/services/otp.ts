import Twilio from "twilio";

import { ENV } from "../config/env";

const isTest = process.env.NODE_ENV === "test";

let client: ReturnType<typeof Twilio> | null = null;

if (!isTest) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio env missing in non-test mode");
  }

  client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

export async function sendOtp(phone: string) {
  if (isTest) {
    return { sid: "test" };
  }

  if (!client) {
    throw new Error("Twilio client not initialized");
  }
  const verifyServiceSid = ENV.TWILIO_VERIFY_SERVICE_SID;
  if (!verifyServiceSid) {
    throw new Error("Twilio verify service is not configured");
  }

  return client.verify.v2
    .services(verifyServiceSid)
    .verifications.create({
      to: phone,
      channel: "sms",
    });
}

export async function checkOtp(phone: string, code: string): Promise<boolean> {
  if (isTest) {
    return code === "123456";
  }

  if (!client) {
    throw new Error("Twilio client not initialized");
  }
  const verifyServiceSid = ENV.TWILIO_VERIFY_SERVICE_SID;
  if (!verifyServiceSid) {
    throw new Error("Twilio verify service is not configured");
  }

  const result = await client.verify.v2
    .services(verifyServiceSid)
    .verificationChecks.create({
      to: phone,
      code,
    });

  return result.status === "approved";
}
