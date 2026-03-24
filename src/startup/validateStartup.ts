import { config } from "../config";
import { loadRequiredSecrets } from "../config/secrets";

export function validateStartup() {
  loadRequiredSecrets();

  if (!config.auth.jwtSecret) {
    throw new Error("Missing JWT secret");
  }

  if (!config.db.url && !config.db.skip) {
    throw new Error("Missing DATABASE_URL");
  }

  if (!config.sentry.dsn) {
    throw new Error("Missing SENTRY_DSN");
  }

  if (!config.alerting.slackWebhookUrl) {
    throw new Error("Missing SLACK_ALERT_WEBHOOK_URL");
  }
}
