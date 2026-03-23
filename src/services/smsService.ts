import { fetchTwilioClient } from "./twilio";
import { config } from "@/config";

export async function sendSMS(to: string, body: string): Promise<{ success: boolean } | void> {
  if (config.app.testMode === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  const from = config.twilio.number || config.twilio.phone;
  if (!from || !to) {
    return;
  }

  const client = fetchTwilioClient();
  await client.messages.create({ to, from, body });
}
