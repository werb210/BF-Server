import { config } from "../config";
import { logger } from "../platform/logger";
import { pushDeadLetter } from "../lib/deadLetter";
import { withRetry } from "../lib/retry";

export async function sendSlackAlert(message: string): Promise<void> {
  const webhookUrl = config.alerting.slackWebhookUrl;
  if (!webhookUrl) {
    logger.warn("slack_alert_not_configured");
    return;
  }

  try {
    await withRetry(async () => {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: `[BF-Server] ${message}` }),
      });

      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`slack_alert_delivery_failed:${response.status}:${responseBody}`);
      }
    });
  } catch (error) {
    await pushDeadLetter({
      type: "slack_webhook",
      data: { message },
      error: String(error),
    });
    logger.error("slack_alert_delivery_failed", { error: String(error) });
  }
}
