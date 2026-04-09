import { fetchRequestId, fetchRequestRoute, fetchRequestIdempotencyKeyHash } from "../observability/requestContext.js";
import { logWarn } from "./logger.js";
import { trackEvent } from "./appInsights.js";
export function recordTransactionRollback(error) {
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
