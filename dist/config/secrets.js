"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.secrets = void 0;
exports.loadRequiredSecrets = loadRequiredSecrets;
const zod_1 = require("zod");
const RequiredSecretsSchema = zod_1.z.object({
    JWT_SECRET: zod_1.z.string().min(1, "JWT_SECRET is required"),
    DATABASE_URL: zod_1.z.string().min(1, "DATABASE_URL is required"),
    SENTRY_DSN: zod_1.z.string().min(1, "SENTRY_DSN is required"),
    SLACK_ALERT_WEBHOOK_URL: zod_1.z.string().min(1, "SLACK_ALERT_WEBHOOK_URL is required"),
});
/* eslint-disable no-restricted-syntax */
function loadRequiredSecrets(env = process.env) {
    return RequiredSecretsSchema.parse(env);
}
/* eslint-enable no-restricted-syntax */
const requiredSecrets = loadRequiredSecrets();
exports.secrets = Object.freeze({
    jwt: requiredSecrets.JWT_SECRET,
    sentryDsn: requiredSecrets.SENTRY_DSN,
    slackAlertWebhookUrl: requiredSecrets.SLACK_ALERT_WEBHOOK_URL,
});
