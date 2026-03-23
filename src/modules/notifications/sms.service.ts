import { fetchTwilioClient } from "../../services/twilio";

export async function sendSms({ to, message }: { to: string; message: string }) {
  if (process.env.TEST_MODE === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  const client = fetchTwilioClient();
  return client.messages.create({
    body: message,
    from: process.env.TWILIO_FROM || process.env.TWILIO_NUMBER || process.env.TWILIO_PHONE,
    to,
  });
}
