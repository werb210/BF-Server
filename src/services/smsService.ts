import { fetchTwilioClient } from "./twilio";
import { config } from "../config";
import { withRetry } from "../lib/retry";
import { pushDeadLetter } from "../lib/deadLetter";

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
  try {
    await withRetry(() => client.messages.create({ to, from, body }));
  } catch (error) {
    await pushDeadLetter({
      type: "sms",
      data: { to, from, body },
      error: String(error),
    });
    throw error;
  }
}
