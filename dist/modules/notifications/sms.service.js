import { fetchTwilioClient } from "../../services/twilio.js";
import { config } from "../../config/index.js";
import { withRetry } from "../../lib/retry.js";
import { pushDeadLetter } from "../../lib/deadLetter.js";
export async function sendSms({ to, message }) {
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
    }
    catch (error) {
        await pushDeadLetter({
            type: "sms",
            data: payload,
            error: String(error),
        });
        throw error;
    }
}
