import { config } from "../config";
import { logger } from "../platform/logger";

export async function sendSlackAlert(message: string): Promise<void> {
  const webhookUrl = config.alerting.slackWebhookUrl;
  if (!webhookUrl) {
    logger.warn("slack_alert_not_configured");
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: `[BF-Server] ${message}` }),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    logger.error("slack_alert_delivery_failed", {
      status: response.status,
      responseBody,
    });
  }
}
