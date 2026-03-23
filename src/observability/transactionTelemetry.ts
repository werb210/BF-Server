import { getRequestId, getRequestRoute, getRequestIdempotencyKeyHash } from "../observability/requestContext";
import { logWarn } from "./logger";
import { trackEvent } from "./appInsights";

export function recordTransactionRollback(error?: unknown): void {
  const requestId = getRequestId() ?? "unknown";
  const route = getRequestRoute() ?? "unknown";
  const idempotencyKeyHash = getRequestIdempotencyKeyHash() ?? "missing";
  const message = error instanceof Error ? error.message : undefined;
  logWarn("transaction_rollback", {
    requestId,
    route,
    error: message ?? "unknown_error",
  });
  trackEvent({
    name: "transaction_rollback",
    properties: {
      route,
      requestId,
      idempotencyKeyHash,
    },
  });
}
