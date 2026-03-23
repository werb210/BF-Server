import { runtimeEnv } from "../server/config/config";
import { getRequestRoute } from "../observability/requestContext";

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
    buildId: runtimeEnv.commitSha,
  };
  if (resolvedRoute) {
    merged.route = resolvedRoute;
  }
  return merged;
}
