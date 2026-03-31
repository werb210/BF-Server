import { fetchTwilioClient } from "../../services/twilio";
import { config } from "../../config";
import { withRetry } from "../../lib/retry";
import { pushDeadLetter } from "../../lib/deadLetter";

export async function sendSms({ to, message }: { to: string; message: string }) {
  if (config.app.testMode === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  const client = fetchTwilioClient();
  const payload = {
    body: message,
    from: config.twilio.from || config.twilio.number || config.twilio.phone,
    to,
  };

  try {
    return await withRetry(() => client.messages.create(payload));
  } catch (error) {
    await pushDeadLetter({
      type: "sms",
      data: payload,
      error: String(error),
    });
    throw error;
  }
}
