"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDefaultTimelineLogger = createDefaultTimelineLogger;
exports.createDefaultTaskWriter = createDefaultTaskWriter;
exports.createDefaultSmsSender = createDefaultSmsSender;
exports.createFollowUpActionHandlers = createFollowUpActionHandlers;
exports.executeFollowUpAction = executeFollowUpAction;
const crypto_1 = require("crypto");
const logger_1 = require("../../observability/logger");
const audit_service_1 = require("../audit/audit.service");
const followup_store_1 = require("./followup.store");
function createDefaultTimelineLogger() {
    return async (entry) => {
        try {
            await (0, audit_service_1.recordAuditEvent)({
                action: entry.actionTaken,
                actorUserId: null,
                targetUserId: null,
                targetType: entry.entityType,
                targetId: entry.entityId,
                eventType: "crm_timeline",
                eventAction: entry.actionTaken,
                ip: null,
                userAgent: null,
                success: entry.status === "success",
                metadata: {
                    rule_id: entry.ruleId,
                    entity_type: entry.entityType,
                    entity_id: entry.entityId,
                    action_taken: entry.actionTaken,
                    status: entry.status,
                    message: entry.message ?? null,
                    timestamp: entry.executedAt.toISOString(),
                },
            });
        }
        catch (error) {
            (0, logger_1.logError)("followup_timeline_log_failed", {
                error,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    };
}
function createDefaultTaskWriter() {
    return async (task) => {
        await followup_store_1.defaultFollowUpTaskStore.create({
            title: task.title,
            description: task.description ?? null,
            entityId: task.entityId,
            entityType: task.entityType,
        });
    };
}
function createDefaultSmsSender() {
    return async (params) => {
        (0, logger_1.logWarn)("followup_sms_disabled", {
            to: params.to,
            message: params.body,
        });
        return null;
    };
}
function createFollowUpActionHandlers(overrides) {
    return {
        sendSms: overrides?.sendSms ?? createDefaultSmsSender(),
        createTask: overrides?.createTask ?? createDefaultTaskWriter(),
        logTimeline: overrides?.logTimeline ?? createDefaultTimelineLogger(),
    };
}
async function executeFollowUpAction(params) {
    const { action, handlers, entityId, entityType } = params;
    if (action.type === "SEND_SMS") {
        const recipient = params.eventMetadata?.[action.phoneField];
        if (typeof recipient !== "string" || recipient.trim().length === 0) {
            return {
                action,
                status: "skipped",
                message: "Missing recipient phone number.",
            };
        }
        try {
            await handlers.sendSms({
                to: recipient,
                body: action.message,
                metadata: params.eventMetadata ?? null,
            });
            return {
                action,
                status: "success",
                message: "SMS dispatched.",
            };
        }
        catch (error) {
            return {
                action,
                status: "failed",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }
    if (action.type === "CREATE_TASK") {
        try {
            await handlers.createTask({
                id: (0, crypto_1.randomUUID)(),
                title: action.title,
                description: action.description ?? null,
                entityType,
                entityId,
                createdAt: new Date(),
            });
            return {
                action,
                status: "success",
                message: "Task created.",
            };
        }
        catch (error) {
            return {
                action,
                status: "failed",
                message: error instanceof Error ? error.message : String(error),
            };
        }
    }
    return {
        action,
        status: "success",
        message: action.note ?? null,
    };
}
