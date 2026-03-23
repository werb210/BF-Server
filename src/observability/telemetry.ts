import { COMMIT_SHA } from "../server/config/env.compat";
import { getRequestRoute } from "../middleware/requestContext";

const instanceId = process.env.INSTANCE_ID ?? process.env.HOSTNAME ?? "unknown";

export function buildTelemetryProperties(
  properties?: Record<string, unknown>,
  route?: string
): Record<string, unknown> {
  const resolvedRoute =
    route ??
    (typeof properties?.route === "string" ? properties.route : undefined) ??
    getRequestRoute();
  const merged: Record<string, unknown> = {
    ...properties,
    instanceId,
    buildId: COMMIT_SHA,
  };
  if (resolvedRoute) {
    merged.route = resolvedRoute;
  }
  return merged;
}
