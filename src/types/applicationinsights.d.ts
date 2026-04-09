declare module "applicationinsights" {
  export namespace Contracts {
    interface RequestTelemetry {
      [key: string]: unknown;
    }
    interface DependencyTelemetry {
      [key: string]: unknown;
    }
    interface ExceptionTelemetry {
      [key: string]: unknown;
    }
    interface EventTelemetry {
      [key: string]: unknown;
    }
  }

  export interface TelemetryClient {
    trackRequest(telemetry: Contracts.RequestTelemetry): void;
    trackDependency(telemetry: Contracts.DependencyTelemetry): void;
    trackException(telemetry: Contracts.ExceptionTelemetry): void;
    trackEvent(telemetry: Contracts.EventTelemetry): void;
  }

  interface Setup {
    setAutoCollectRequests(value: boolean): Setup;
    setAutoCollectDependencies(value: boolean): Setup;
    setAutoCollectExceptions(value: boolean): Setup;
    setAutoCollectPerformance(value: boolean, collectExtendedMetrics?: boolean): Setup;
    setAutoCollectConsole(value: boolean, collectErrors?: boolean): Setup;
    setSendLiveMetrics(value: boolean): Setup;
    start(): void;
  }

  export function setup(connectionString?: string): Setup;

  const appInsights: {
    setup: typeof setup;
    defaultClient?: TelemetryClient;
  };

  export default appInsights;
}
