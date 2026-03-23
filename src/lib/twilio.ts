import { config } from "../config";
import { twilioClient } from "../platform/twilioClient";

export async function sendSMS(to: string, body: string) {
  return twilioClient.messages.create({
    body,
    from: config.twilio.phone,
    to,
  });
}
