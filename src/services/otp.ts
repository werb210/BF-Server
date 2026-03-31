import twilio from "twilio";
import { ENV } from "../config/env";

const isTest = process.env.NODE_ENV === "test";

const client = isTest
  ? null
  : twilio(ENV.TWILIO_ACCOUNT_SID, ENV.TWILIO_AUTH_TOKEN);

export async function sendOtp(phone: string) {
  if (isTest) {
    return { sid: "test" };
  }

  return client.verify.v2
    .services(ENV.TWILIO_VERIFY_SERVICE_SID)
    .verifications.create({
      to: phone,
      channel: "sms",
    });
}

export async function checkOtp(phone: string, code: string): Promise<boolean> {
  if (isTest) {
    return code === "123456";
  }

  const result = await client.verify.v2
    .services(ENV.TWILIO_VERIFY_SERVICE_SID)
    .verificationChecks.create({
      to: phone,
      code,
    });

  return result.status === "approved";
}
