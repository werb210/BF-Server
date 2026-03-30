"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startFollowUpJobs = startFollowUpJobs;
const config_1 = require("../../config");
const logger_1 = require("../../observability/logger");
const followup_actions_1 = require("./followup.actions");
const followup_engine_1 = require("./followup.engine");
const followup_rules_1 = require("./followup.rules");
const followup_store_1 = require("./followup.store");
function startFollowUpJobs() {
    if (!config_1.config.followUp.enabled) {
        return { stop: () => undefined };
    }
    const intervalMs = config_1.config.followUp.intervalMs;
    const handlers = (0, followup_actions_1.createFollowUpActionHandlers)();
    const runOnce = () => {
        (0, followup_engine_1.evaluateFollowUpRules)({
            rules: followup_rules_1.followUpRules,
            store: followup_store_1.defaultFollowUpEventStore,
            idempotency: followup_store_1.defaultFollowUpIdempotencyStore,
            actions: handlers,
        }).catch((error) => {
            (0, logger_1.logError)("followup_scheduler_failed", {
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
