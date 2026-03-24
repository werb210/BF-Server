import { z } from "zod";

const RequiredSecretsSchema = z.object({
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SENTRY_DSN: z.string().min(1, "SENTRY_DSN is required"),
  SLACK_ALERT_WEBHOOK_URL: z.string().min(1, "SLACK_ALERT_WEBHOOK_URL is required"),
});

export type RequiredSecrets = z.infer<typeof RequiredSecretsSchema>;

/* eslint-disable no-restricted-syntax */
export function loadRequiredSecrets(env: Record<string, string | undefined> = process.env): RequiredSecrets {
  return RequiredSecretsSchema.parse(env);
}
/* eslint-enable no-restricted-syntax */

const requiredSecrets = loadRequiredSecrets();

export const secrets = Object.freeze({
  jwt: requiredSecrets.JWT_SECRET,
  sentryDsn: requiredSecrets.SENTRY_DSN,
  slackAlertWebhookUrl: requiredSecrets.SLACK_ALERT_WEBHOOK_URL,
});
