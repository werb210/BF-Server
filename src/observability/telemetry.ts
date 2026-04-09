import { config } from "../config/index.js";
import { fetchRequestRoute } from "../observability/requestContext.js";

const instanceId = config.telemetry.instanceId;

export function buildTelemetryProperties(
  properties?: Record<string, unknown>,
  route?: string
): Record<string, unknown> {
  const resolvedRoute =
    route ??
    (typeof properties?.route === "string" ? properties.route : undefined) ??
    fetchRequestRoute();
  const merged: Record<string, unknown> = {
    ...properties,
    instanceId,
    buildId: config.commitSha,
  };
  if (resolvedRoute) {
    merged.route = resolvedRoute;
  }
  return merged;
}
