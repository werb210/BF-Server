"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateStartup = validateStartup;
const config_1 = require("../config");
const secrets_1 = require("../config/secrets");
function validateStartup() {
    (0, secrets_1.loadRequiredSecrets)();
    if (!config_1.config.auth.jwtSecret) {
        throw new Error("Missing JWT secret");
    }
    if (!config_1.config.db.url && !config_1.config.db.skip) {
        throw new Error("DATABASE_URL missing");
    }
    if (!config_1.config.sentry.dsn) {
        throw new Error("Missing SENTRY_DSN");
    }
    if (!config_1.config.alerting.slackWebhookUrl) {
        throw new Error("Missing SLACK_ALERT_WEBHOOK_URL");
    }
}
