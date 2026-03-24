import * as Sentry from "@sentry/node";
import type { Express } from "express";
import { config } from "../config";

let initialized = false;

export function initializeSentry(): void {
  if (initialized) return;

  if (!config.sentry.dsn) {
    throw new Error("Missing SENTRY_DSN");
  }

  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    integrations: [Sentry.expressIntegration()],
  });

  initialized = true;
}

export function bindSentryErrorHandler(app: Express): void {
  if (!initialized) return;
  Sentry.setupExpressErrorHandler(app);
}

export function captureException(error: unknown): void {
  if (!initialized) return;
  Sentry.captureException(error);
}
