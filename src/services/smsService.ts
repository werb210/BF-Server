import { fetchTwilioClient } from "./twilio.js";
import { config } from "../config/index.js";
import { withRetry } from "../lib/retry.js";
import { pushDeadLetter } from "../lib/deadLetter.js";
import { isUndeliverableNumber } from "../lib/smsDeliverability.js"; // BF_SERVER_GUARD_EVERYWHERE_v136
import { smsFromFor } from "../lib/smsFrom.js"; // BF_SERVER_US_SMS_TOLLFREE_v755

export async function sendSMS(to: string, body: string): Promise<{ success: boolean } | void> {
  if (config.app.testMode === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  const from = config.twilio.number || config.twilio.phone;
  if (!from || !to) {
    return;
  }

  // BF_SERVER_GUARD_EVERYWHERE_v136
  if (isUndeliverableNumber(to)) {
    console.warn("[sms] skipped undeliverable number", String(to).slice(0, 6));
    return;
  }

  const client = fetchTwilioClient();
  try {
    await withRetry(() => client.messages.create({ to, from: smsFromFor(to, from), body })); // BF_SERVER_US_SMS_TOLLFREE_v755
  } catch (error) {
    await pushDeadLetter({
      type: "sms",
      data: { to, from, body },
      error: String(error),
    });
    throw error;
  }
}
