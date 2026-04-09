import { config } from "../config/index.js";
import { loadRequiredSecrets } from "../config/secrets.js";
export function validateStartup() {
    loadRequiredSecrets();
    if (!config.auth.jwtSecret) {
        throw new Error("Missing JWT secret");
    }
    if (!config.db.url && !config.db.skip) {
        throw new Error("DATABASE_URL missing");
    }
    if (!config.sentry.dsn) {
        throw new Error("Missing SENTRY_DSN");
    }
    if (!config.alerting.slackWebhookUrl) {
        throw new Error("Missing SLACK_ALERT_WEBHOOK_URL");
    }
}
