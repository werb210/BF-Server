import { config } from "../config/index.js";
import { logInfo, logWarn } from "./logger.js";

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

type AppInsightsClient = {
  setup: (connectionString: string) => AppInsightsClient;
  setAutoCollectRequests: (enabled: boolean) => AppInsightsClient;
  setAutoCollectPerformance: (enabled: boolean) => AppInsightsClient;
  setAutoCollectExceptions: (enabled: boolean) => AppInsightsClient;
  start: () => void;
  defaultClient?: TelemetryClient;
};

let appInsights: AppInsightsClient | null = null;
let telemetryClient: TelemetryClient | null = null;
let initialized = false;

export function initAppInsights(): void {
  const key = config.telemetry.appInsightsConnectionString;

  if (!key?.trim()) {
    logWarn("appinsights_disabled", {
      reason: "missing_connection_string",
      testEnvironment: config.env === "test",
    });
    return;
  }

  const mod = requireSafe<AppInsightsClient>("applicationinsights");

  if (!mod) {
    logWarn("appinsights_disabled", {
      reason: "package_missing",
    });
    return;
  }

  try {
    appInsights = mod;

    appInsights
      .setup(key)
      .setAutoCollectRequests(true)
      .setAutoCollectPerformance(true)
      .setAutoCollectExceptions(true)
      .start();

    telemetryClient = appInsights.defaultClient ?? null;
    logInfo("appinsights_initialized");
  } catch (error) {
    logWarn("appinsights_disabled", {
      reason: "initialization_failed",
      error,
    });
  }
}

export function initializeAppInsights(): void {
  if (initialized) {
    return;
  }

  initialized = true;
  initAppInsights();
}

function requireSafe<T>(pkg: string): T | null {
  try {
    return eval("require")(pkg) as T;
  } catch {
    return null;
  }
}

export function trackRequest(telemetry: RequestTelemetry): void {
  telemetryClient?.trackRequest(telemetry);
}

export function trackDependency(telemetry: DependencyTelemetry): void {
  telemetryClient?.trackDependency(telemetry);
}

export function trackException(telemetry: ExceptionTelemetry): void {
  telemetryClient?.trackException(telemetry);
}

export function trackEvent(telemetry: EventTelemetry): void {
  telemetryClient?.trackEvent?.(telemetry);
}
