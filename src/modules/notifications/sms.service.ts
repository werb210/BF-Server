import { fetchTwilioClient } from "../../services/twilio.js";
import { config } from "../../config/index.js";
import { withRetry } from "../../lib/retry.js";
import { pushDeadLetter } from "../../lib/deadLetter.js";
import { isPermanentSmsFailure, isUndeliverableNumber } from "../../lib/smsDeliverability.js";

// BF_SERVER_SMS_LOOP_KILL_v121
export class UndeliverableNumberError extends Error {
  readonly code = 21211;
  constructor(to: string) {
    super(`undeliverable_number:${to}`);
    this.name = "UndeliverableNumberError";
  }
}

export async function sendSms(
  { to, message }: { to: string; message: string },
  options: { enqueueOnFailure?: boolean } = {},
) {
  const { enqueueOnFailure = true } = options;
  if (config.app.testMode === "true") {
    console.log("[TEST_MODE] SMS skipped");
    return { success: true };
  }

  if (isUndeliverableNumber(to)) {
    console.warn("[sms] undeliverable number, not sent", { to: String(to).slice(0, 6) });
    throw new UndeliverableNumberError(String(to));
  }

  const client = fetchTwilioClient();
  const payload = {
    body: message,
    from: config.twilio.from || config.twilio.number || config.twilio.phone,
    to,
  };

  try {
    return await withRetry(() => client.messages.create(payload), {
      retries: 3,
      shouldRetry: (error) => !isPermanentSmsFailure(error),
    });
  } catch (error) {
    if (enqueueOnFailure) {
      await pushDeadLetter({ type: "sms", data: payload, error: String(error) });
    }
    throw error;
  }
}
