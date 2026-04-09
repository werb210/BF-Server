import { randomUUID } from "node:crypto";
import { logError, logWarn } from "../../observability/logger.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  type FollowUpAction,
  type FollowUpActionResult,
  type FollowUpActionHandlers,
  type FollowUpTimelineEntry,
  type FollowUpTask,
} from "./followup.types.js";
import { defaultFollowUpTaskStore } from "./followup.store.js";

export function createDefaultTimelineLogger(): (
  entry: FollowUpTimelineEntry
) => Promise<void> {
  return async (entry) => {
    try {
      await recordAuditEvent({
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
    } catch (error) {
      logError("followup_timeline_log_failed", {
        error,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function createDefaultTaskWriter(): (task: FollowUpTask) => Promise<void> {
  return async (task) => {
    await defaultFollowUpTaskStore.create({
      title: task.title,
      description: task.description ?? null,
      entityId: task.entityId,
      entityType: task.entityType,
    });
  };
}

export function createDefaultSmsSender(): (
  params: {
    to: string;
    body: string;
    metadata?: Record<string, unknown> | null;
  }
) => Promise<{ provider: string; messageId?: string | null } | null> {
  return async (params) => {
    logWarn("followup_sms_disabled", {
      to: params.to,
      message: params.body,
    });
    return null;
  };
}

export function createFollowUpActionHandlers(
  overrides?: Partial<FollowUpActionHandlers>
): FollowUpActionHandlers {
  return {
    sendSms: overrides?.sendSms ?? createDefaultSmsSender(),
    createTask: overrides?.createTask ?? createDefaultTaskWriter(),
    logTimeline: overrides?.logTimeline ?? createDefaultTimelineLogger(),
  };
}

export async function executeFollowUpAction(params: {
  action: FollowUpAction;
  entityType: FollowUpTask["entityType"];
  entityId: string;
  eventMetadata?: Record<string, unknown> | null;
  handlers: FollowUpActionHandlers;
}): Promise<FollowUpActionResult> {
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
    } catch (error) {
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
        id: randomUUID(),
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
    } catch (error) {
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
