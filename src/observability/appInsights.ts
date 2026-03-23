import * as appInsights from "applicationinsights";
import { isTestEnvironment } from "../server/config/env.compat";
import { logInfo, logWarn } from "./logger";

type RequestTelemetry = {
  name: string;
  url: string;
  duration: number;
  resultCode: number;
  success: boolean;
  properties?: Record<string, unknown>;
};

type DependencyTelemetry = {
  name: string;
  target?: string;
  data?: string;
  duration: number;
  success: boolean;
  dependencyTypeName?: string;
};

type ExceptionTelemetry = {
  exception: Error;
  properties?: Record<string, unknown>;
};

type EventTelemetry = {
  name: string;
  properties?: Record<string, unknown>;
};

type TelemetryClient = {
  trackRequest: (telemetry: RequestTelemetry) => void;
  trackDependency: (telemetry: DependencyTelemetry) => void;
  trackException: (telemetry: ExceptionTelemetry) => void;
  trackEvent?: (telemetry: EventTelemetry) => void;
};

let telemetryClient: TelemetryClient | null = null;
let initialized = false;

function isValidConnectionString(connectionString: string): boolean {
  const match = connectionString.match(/InstrumentationKey=([0-9a-fA-F-]{36})/);
  if (!match || !match[1]) {
    return false;
  }
  const guidPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return guidPattern.test(match[1]);
}

export function initializeAppInsights(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  try {
    const connectionString =
      process.env.APPINSIGHTS_CONNECTION_STRING ??
      process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;

    if (!connectionString?.trim()) {
      logWarn("appinsights_disabled", {
        reason: "missing_connection_string",
        testEnvironment: isTestEnvironment(),
      });
      return;
    }

    if (!isValidConnectionString(connectionString)) {
      logWarn("appinsights_disabled", {
        reason: "invalid_connection_string",
      });
      telemetryClient = null;
      return;
    }

    if (typeof appInsights.setup !== "function") {
      logWarn("appinsights_disabled", {
        reason: "setup_unavailable",
      });
      return;
    }

    appInsights
      .setup(connectionString)
      .setAutoCollectConsole(false, false)
      .setAutoCollectExceptions(true)
      .setAutoCollectPerformance(false, false)
      .setAutoCollectRequests(true)
      .setAutoCollectDependencies(true)
      .setSendLiveMetrics(false)
      .start();

    telemetryClient =
      (appInsights as { defaultClient?: TelemetryClient }).defaultClient ?? null;
    logInfo("appinsights_initialized");
  } catch (error) {
    logWarn("appinsights_disabled", {
      reason: "initialization_failed",
      error,
    });
  }
}

export function trackRequest(
  telemetry: RequestTelemetry
): void {
  telemetryClient?.trackRequest(telemetry);
}

export function trackDependency(
  telemetry: DependencyTelemetry
): void {
  telemetryClient?.trackDependency(telemetry);
}

export function trackException(
  telemetry: ExceptionTelemetry
): void {
  telemetryClient?.trackException(telemetry);
}

export function trackEvent(
  telemetry: EventTelemetry
): void {
  telemetryClient?.trackEvent?.(telemetry);
}
