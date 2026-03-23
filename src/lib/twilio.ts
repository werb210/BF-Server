import { twilioClient } from "../platform/twilioClient";
import { config } from "../config";

export async function sendSMS(to: string, body: string) {
  return twilioClient.messages.create({
    body,
    from: config.twilio.phone,
    to,
  });
}
