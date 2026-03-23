import { fetchTwilioClient } from "../../services/twilio";
import { config } from "../../config";

export async function sendSms({ to, message }: { to: string; message: string }) {
  if (config.app.testMode === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  const client = fetchTwilioClient();
  return client.messages.create({
    body: message,
    from: config.twilio.from || config.twilio.number || config.twilio.phone,
    to,
  });
}
