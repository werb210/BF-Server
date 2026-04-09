import { config } from "../config/index.js";
import { pushDeadLetter } from "../lib/deadLetter.js";
import { withRetry } from "../lib/retry.js";

export async function pushLeadToCRM(data: Record<string, unknown>): Promise<void> {
  if (!config.crm.webhookUrl) {
    return;
  }

  try {
    await withRetry(async () => {
      const response = await fetch(config.crm.webhookUrl as string, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!response.ok) {
        throw new Error(`crm_webhook_failed:${response.status}:${await response.text()}`);
      }
    });
  } catch (error) {
    await pushDeadLetter({
      type: "partner_webhook",
      data,
      error: String(error),
    });
    throw error;
  }
}
