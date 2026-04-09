import { config } from "../../config/index.js";
import { logError } from "../../observability/logger.js";
import { createFollowUpActionHandlers } from "./followup.actions.js";
import { evaluateFollowUpRules } from "./followup.engine.js";
import { followUpRules } from "./followup.rules.js";
import { defaultFollowUpEventStore, defaultFollowUpIdempotencyStore, } from "./followup.store.js";
export function startFollowUpJobs() {
    if (!config.followUp.enabled) {
        return { stop: () => undefined };
    }
    const intervalMs = config.followUp.intervalMs;
    const handlers = createFollowUpActionHandlers();
    const runOnce = () => {
        evaluateFollowUpRules({
            rules: followUpRules,
            store: defaultFollowUpEventStore,
            idempotency: defaultFollowUpIdempotencyStore,
            actions: handlers,
        }).catch((error) => {
            logError("followup_scheduler_failed", {
                error,
                message: error instanceof Error ? error.message : String(error),
            });
        });
    };
    const timer = setInterval(runOnce, intervalMs);
    runOnce();
    return {
        stop: () => clearInterval(timer),
    };
}
