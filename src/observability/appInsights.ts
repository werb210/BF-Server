import type { TelemetryClient, Contracts } from "applicationinsights";

let client: TelemetryClient | null = null;

function safeRequire<T = any>(name: string): T | null {
  try {
    // eslint-disable-next-line no-eval
    return eval("require")(name);
  } catch {
    return null;
  }
}

export function initializeAppInsights(): void {
  if (client) return;

  const ai = safeRequire<typeof import("applicationinsights")>("applicationinsights");
  if (!ai) return;

  ai.setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
    .setAutoCollectRequests(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectPerformance(true)
    .start();

  client = (ai as any).defaultClient ?? (ai as any).default?.defaultClient ?? null;
}

function getClient(): TelemetryClient | null {
  return client;
}

export function trackRequest(telemetry: Contracts.RequestTelemetry): void {
  const c = getClient();
  if (!c) return;
  c.trackRequest(telemetry);
}

export function trackDependency(telemetry: Contracts.DependencyTelemetry): void {
  const c = getClient();
  if (!c) return;
  c.trackDependency(telemetry);
}

export function trackException(telemetry: Contracts.ExceptionTelemetry): void {
  const c = getClient();
  if (!c) return;
  c.trackException(telemetry);
}

export function trackEvent(telemetry: Contracts.EventTelemetry): void {
  const c = getClient();
  if (!c) return;
  c.trackEvent(telemetry);
}
