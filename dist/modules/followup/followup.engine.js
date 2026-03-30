"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConditionMet = isConditionMet;
exports.isRuleMatch = isRuleMatch;
exports.evaluateFollowUpRules = evaluateFollowUpRules;
const logger_1 = require("../../observability/logger");
const followup_actions_1 = require("./followup.actions");
function minutesBetween(now, then) {
    return (now.getTime() - then.getTime()) / 60000;
}
function fetchMetadataValue(metadata, key) {
    if (!metadata) {
        return undefined;
    }
    return metadata[key];
}
function isConditionMet(condition, params) {
    const { triggerEvent, now, store } = params;
    if (condition.type === "metadata_equals") {
        return fetchMetadataValue(triggerEvent.metadata, condition.key) === condition.value;
    }
    if (condition.type === "metadata_number_gte") {
        const value = fetchMetadataValue(triggerEvent.metadata, condition.key);
        return typeof value === "number" && value >= condition.value;
    }
    if (condition.type === "not_event_since") {
        const elapsedMinutes = minutesBetween(now, triggerEvent.occurredAt);
        if (elapsedMinutes < condition.minutes) {
            return false;
        }
        const relatedEvents = store.listEvents({
            type: condition.eventType,
            entityType: triggerEvent.entityType,
            entityId: triggerEvent.entityId,
        });
        return !relatedEvents.some((event) => event.occurredAt > triggerEvent.occurredAt);
    }
    return false;
}
function isRuleMatch(params) {
    const { rule, triggerEvent, now, store } = params;
    return rule.conditions.every((condition) => isConditionMet(condition, { triggerEvent, now, store }));
}
async function evaluateFollowUpRules(params) {
    const now = params.now ?? new Date();
    const results = [];
    for (const rule of params.rules) {
        const events = params.store.listEvents({ type: rule.triggerEvent });
        for (const event of events) {
            const idempotencyKey = `${rule.id}:${event.id}`;
            if (params.idempotency.has(idempotencyKey)) {
                continue;
            }
            try {
                if (!isRuleMatch({ rule, triggerEvent: event, now, store: params.store })) {
                    continue;
                }
                const actionResults = [];
                for (const action of rule.actions) {
                    const actionResult = await (0, followup_actions_1.executeFollowUpAction)({
                        action,
                        entityType: event.entityType,
                        entityId: event.entityId,
                        eventMetadata: event.metadata ?? null,
                        handlers: params.actions,
                    });
                    actionResults.push(actionResult);
                    await params.actions.logTimeline({
                        ruleId: rule.id,
                        entityType: event.entityType,
                        entityId: event.entityId,
                        actionTaken: action.type,
                        status: actionResult.status,
                        message: actionResult.message ?? null,
                        executedAt: now,
                    });
                }
                params.idempotency.mark(idempotencyKey);
                results.push({
                    ruleId: rule.id,
                    eventId: event.id,
                    entityType: event.entityType,
                    entityId: event.entityId,
                    actionResults,
                });
            }
            catch (error) {
                (0, logger_1.logError)("followup_rule_execution_failed", {
                    ruleId: rule.id,
                    eventId: event.id,
                    error,
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
    return results;
}
