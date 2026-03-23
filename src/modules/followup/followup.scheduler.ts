import { config } from "../../config";
import { logError } from "../../observability/logger";
import { createFollowUpActionHandlers } from "./followup.actions";
import { evaluateFollowUpRules } from "./followup.engine";
import { followUpRules } from "./followup.rules";
import {
  defaultFollowUpEventStore,
  defaultFollowUpIdempotencyStore,
} from "./followup.store";

export function startFollowUpJobs(): { stop: () => void } {
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
