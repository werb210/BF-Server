import { randomUUID } from "crypto";
import { fetchOcrFieldDefinitions, fetchOcrFieldsForDocumentType } from "./fieldRegistry";
import {
  findApplicationOcrSnapshot,
  updateApplicationOcrInsights,
} from "../modules/applications/applications.repo";
import { listOcrResultsForApplication } from "../modules/ocr/ocr.repo";
import { recordAuditEvent } from "../modules/audit/audit.service";
import { createNotification } from "../modules/notifications/notifications.repo";
import { logError } from "../observability/logger";

export type OcrDocumentResult = {
  documentId: string;
  documentType: string;
  extractedJson: unknown | null;
};

export type OcrInsights = {
  missingFields: string[];
  conflictingFields: string[];
  normalizedValues: Record<string, string>;
};

function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0
      ? trimmed.replace(/\s+/g, " ").toLowerCase()
      : null;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    return normalizeValue(value[0]);
  }
  if (typeof value === "object") {
    const record = value as { value?: unknown; normalized?: unknown };
    if (record.normalized !== undefined) {
      return normalizeValue(record.normalized);
    }
    if (record.value !== undefined) {
      return normalizeValue(record.value);
    }
  }
  return null;
}

function extractFieldValue(extractedJson: unknown, fieldName: string): string | null {
  if (!extractedJson || typeof extractedJson !== "object") {
    return null;
  }
  const record = extractedJson as Record<string, unknown>;
  const directValue = record[fieldName];
  if (directValue !== undefined) {
    return normalizeValue(directValue);
  }
  const fields = record.fields;
  if (fields && typeof fields === "object") {
    const fieldValue = (fields as Record<string, unknown>)[fieldName];
    if (fieldValue !== undefined) {
      return normalizeValue(fieldValue);
    }
  }
  const normalized = record.normalized;
  if (normalized && typeof normalized === "object") {
    const normalizedValue = (normalized as Record<string, unknown>)[fieldName];
    if (normalizedValue !== undefined) {
      return normalizeValue(normalizedValue);
    }
  }
  return null;
}

function resolveNormalizedValue(values: string[]): string | null {
  if (values.length === 0) {
    return null;
  }
  const counts = new Map<string, number>();
  values.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });
  return sorted[0]?.[0] ?? null;
}

function toSortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => typeof item === "string") as string[];
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

export function buildOcrInsights(results: OcrDocumentResult[]): OcrInsights {
  const valuesByField = new Map<string, string[]>();
  const registry = fetchOcrFieldDefinitions();

  results.forEach((result) => {
    const fieldsForDoc = fetchOcrFieldsForDocumentType();
    fieldsForDoc.forEach((field) => {
      const extracted = extractFieldValue(result.extractedJson, field.field_key);
      if (!extracted) {
        return;
      }
      const existing = valuesByField.get(field.field_key) ?? [];
      existing.push(extracted);
      valuesByField.set(field.field_key, existing);
    });
  });

  const missingFields: string[] = [];
  const conflictingFields: string[] = [];
  const normalizedValues: Record<string, string> = {};

  registry.forEach((field) => {
    const values = valuesByField.get(field.field_key) ?? [];
    const uniqueValues = toSortedUnique(values);

    if (field.required && uniqueValues.length === 0) {
      missingFields.push(field.field_key);
    }

    if (uniqueValues.length > 1) {
      conflictingFields.push(field.field_key);
    }

    const normalized = resolveNormalizedValue(uniqueValues);
    if (normalized) {
      normalizedValues[field.field_key] = normalized;
    }
  });

  return {
    missingFields: toSortedUnique(missingFields),
    conflictingFields: toSortedUnique(conflictingFields),
    normalizedValues,
  };
}

export async function refreshOcrInsightsForApplication(params: {
  applicationId: string;
  actorUserId?: string | null;
  source?: string | null;
}): Promise<OcrInsights> {
  const { applicationId } = params;
  const [existing, results] = await Promise.all([
    findApplicationOcrSnapshot(applicationId),
    listOcrResultsForApplication(applicationId),
  ]);

  const insights = buildOcrInsights(
    results.map((row) => ({
      documentId: row.document_id,
      documentType: row.document_type,
      extractedJson: row.extracted_json,
    }))
  );

  await updateApplicationOcrInsights({
    applicationId,
    missingFields: insights.missingFields,
    conflictingFields: insights.conflictingFields,
    normalizedValues: insights.normalizedValues,
  });

  const previousMissing = parseStringArray(existing?.ocr_missing_fields);
  const previousConflicts = parseStringArray(existing?.ocr_conflicting_fields);
  const hasMissing = insights.missingFields.length > 0;
  const hasConflicts = insights.conflictingFields.length > 0;

  const missingChanged = !setsEqual(previousMissing, insights.missingFields);
  const conflictsChanged = !setsEqual(previousConflicts, insights.conflictingFields);

  const shouldEmitMissing = hasMissing && (missingChanged || !existing?.ocr_has_missing_fields);
  const shouldEmitConflicts =
    hasConflicts && (conflictsChanged || !existing?.ocr_has_conflicts);

  if (shouldEmitMissing) {
    try {
      await recordAuditEvent({
        action: "OCR_MISSING_FIELDS",
        actorUserId: params.actorUserId ?? null,
        targetUserId: null,
        targetType: "application",
        targetId: applicationId,
        eventType: "OCR_MISSING_FIELDS",
        eventAction: "OCR_MISSING_FIELDS",
        success: true,
        metadata: {
          missingFields: insights.missingFields,
          source: params.source ?? null,
        },
      });
    } catch (error) {
      logError("ocr_missing_fields_event_failed", {
        code: "ocr_missing_fields_event_failed",
        applicationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await createNotification({
        notificationId: randomUUID(),
        userId: null,
        applicationId,
        type: "ocr_missing_fields",
        title: "OCR missing required fields",
        body: `Missing OCR fields: ${insights.missingFields.join(", ")}`,
        metadata: {
          missingFields: insights.missingFields,
        },
      });
    } catch (error) {
      logError("ocr_missing_fields_notification_failed", {
        code: "ocr_missing_fields_notification_failed",
        applicationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (shouldEmitConflicts) {
    try {
      await recordAuditEvent({
        action: "OCR_CONFLICT_DETECTED",
        actorUserId: params.actorUserId ?? null,
        targetUserId: null,
        targetType: "application",
        targetId: applicationId,
        eventType: "OCR_CONFLICT_DETECTED",
        eventAction: "OCR_CONFLICT_DETECTED",
        success: true,
        metadata: {
          conflictingFields: insights.conflictingFields,
          source: params.source ?? null,
        },
      });
    } catch (error) {
      logError("ocr_conflict_event_failed", {
        code: "ocr_conflict_event_failed",
        applicationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await createNotification({
        notificationId: randomUUID(),
        userId: null,
        applicationId,
        type: "ocr_conflict_detected",
        title: "OCR conflict detected",
        body: `Conflicting OCR fields: ${insights.conflictingFields.join(", ")}`,
        metadata: {
          conflictingFields: insights.conflictingFields,
        },
      });
    } catch (error) {
      logError("ocr_conflict_notification_failed", {
        code: "ocr_conflict_notification_failed",
        applicationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return insights;
}
