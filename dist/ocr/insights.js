"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildOcrInsights = buildOcrInsights;
exports.refreshOcrInsightsForApplication = refreshOcrInsightsForApplication;
const crypto_1 = require("crypto");
const fieldRegistry_1 = require("./fieldRegistry");
const applications_repo_1 = require("../modules/applications/applications.repo");
const ocr_repo_1 = require("../modules/ocr/ocr.repo");
const audit_service_1 = require("../modules/audit/audit.service");
const notifications_repo_1 = require("../modules/notifications/notifications.repo");
const logger_1 = require("../observability/logger");
function normalizeValue(value) {
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
        const record = value;
        if (record.normalized !== undefined) {
            return normalizeValue(record.normalized);
        }
        if (record.value !== undefined) {
            return normalizeValue(record.value);
        }
    }
    return null;
}
function extractFieldValue(extractedJson, fieldName) {
    if (!extractedJson || typeof extractedJson !== "object") {
        return null;
    }
    const record = extractedJson;
    const directValue = record[fieldName];
    if (directValue !== undefined) {
        return normalizeValue(directValue);
    }
    const fields = record.fields;
    if (fields && typeof fields === "object") {
        const fieldValue = fields[fieldName];
        if (fieldValue !== undefined) {
            return normalizeValue(fieldValue);
        }
    }
    const normalized = record.normalized;
    if (normalized && typeof normalized === "object") {
        const normalizedValue = normalized[fieldName];
        if (normalizedValue !== undefined) {
            return normalizeValue(normalizedValue);
        }
    }
    return null;
}
function resolveNormalizedValue(values) {
    if (values.length === 0) {
        return null;
    }
    const counts = new Map();
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
function toSortedUnique(values) {
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
function parseStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item) => typeof item === "string");
}
function setsEqual(a, b) {
    if (a.length !== b.length) {
        return false;
    }
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    return sortedA.every((value, index) => value === sortedB[index]);
}
function buildOcrInsights(results) {
    const valuesByField = new Map();
    const registry = (0, fieldRegistry_1.fetchOcrFieldDefinitions)();
    results.forEach((result) => {
        const fieldsForDoc = (0, fieldRegistry_1.fetchOcrFieldsForDocumentType)();
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
    const missingFields = [];
    const conflictingFields = [];
    const normalizedValues = {};
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
async function refreshOcrInsightsForApplication(params) {
    const { applicationId } = params;
    const [existing, results] = await Promise.all([
        (0, applications_repo_1.findApplicationOcrSnapshot)(applicationId),
        (0, ocr_repo_1.listOcrResultsForApplication)(applicationId),
    ]);
    const insights = buildOcrInsights(results.map((row) => ({
        documentId: row.document_id,
        documentType: row.document_type,
        extractedJson: row.extracted_json,
    })));
    await (0, applications_repo_1.updateApplicationOcrInsights)({
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
    const shouldEmitConflicts = hasConflicts && (conflictsChanged || !existing?.ocr_has_conflicts);
    if (shouldEmitMissing) {
        try {
            await (0, audit_service_1.recordAuditEvent)({
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
        }
        catch (error) {
            (0, logger_1.logError)("ocr_missing_fields_event_failed", {
                code: "ocr_missing_fields_event_failed",
                applicationId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        try {
            await (0, notifications_repo_1.createNotification)({
                notificationId: (0, crypto_1.randomUUID)(),
                userId: null,
                applicationId,
                type: "ocr_missing_fields",
                title: "OCR missing required fields",
                body: `Missing OCR fields: ${insights.missingFields.join(", ")}`,
                metadata: {
                    missingFields: insights.missingFields,
                },
            });
        }
        catch (error) {
            (0, logger_1.logError)("ocr_missing_fields_notification_failed", {
                code: "ocr_missing_fields_notification_failed",
                applicationId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    if (shouldEmitConflicts) {
        try {
            await (0, audit_service_1.recordAuditEvent)({
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
        }
        catch (error) {
            (0, logger_1.logError)("ocr_conflict_event_failed", {
                code: "ocr_conflict_event_failed",
                applicationId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        try {
            await (0, notifications_repo_1.createNotification)({
                notificationId: (0, crypto_1.randomUUID)(),
                userId: null,
                applicationId,
                type: "ocr_conflict_detected",
                title: "OCR conflict detected",
                body: `Conflicting OCR fields: ${insights.conflictingFields.join(", ")}`,
                metadata: {
                    conflictingFields: insights.conflictingFields,
                },
            });
        }
        catch (error) {
            (0, logger_1.logError)("ocr_conflict_notification_failed", {
                code: "ocr_conflict_notification_failed",
                applicationId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return insights;
}
