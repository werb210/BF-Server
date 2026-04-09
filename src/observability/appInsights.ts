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

type AppInsightsModule = {
  setup: (connectionString: string) => {
    setAutoCollectRequests: (enabled: boolean) => unknown;
    setAutoCollectPerformance: (enabled: boolean) => unknown;
    setAutoCollectExceptions: (enabled: boolean) => unknown;
    start: () => unknown;
  };
  defaultClient?: TelemetryClient;
};

let appInsights: AppInsightsModule | null = null;
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

  try {
    const mod = requireSafe("applicationinsights") as AppInsightsModule | null;

    if (!mod) {
      logWarn("appinsights_disabled", {
        reason: "package_missing",
      });
      return;
    }

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

function requireSafe(pkg: string): unknown {
  try {
    return eval("require")(pkg);
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
