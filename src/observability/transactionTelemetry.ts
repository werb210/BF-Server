import { fetchRequestId, fetchRequestRoute, fetchRequestIdempotencyKeyHash } from "../observability/requestContext";
import { logWarn } from "./logger";
import { trackEvent } from "./appInsights";

export function recordTransactionRollback(error?: unknown): void {
  const requestId = fetchRequestId() ?? "unknown";
  const route = fetchRequestRoute() ?? "unknown";
  const idempotencyKeyHash = fetchRequestIdempotencyKeyHash() ?? "missing";
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
