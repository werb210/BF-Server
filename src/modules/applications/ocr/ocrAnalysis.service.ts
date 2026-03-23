import {
  fetchOcrFieldDefinitionByKey,
  fetchOcrFieldRegistry,
  type OcrFieldDefinition,
} from "../../ocr/ocrFieldRegistry";
import { listOcrFieldsForApplication } from "../../ocr/ocr.repo";
import { updateApplicationOcrInsights } from "../applications.repo";

export type OcrFieldSource = {
  documentId: string;
  documentType: string | null;
  page: number | null;
};

export type OcrInsightField = {
  value: string;
  confidence: number;
  sources: OcrFieldSource[];
};

export type OcrInsightsSummary = {
  complete: boolean;
  missingFields: string[];
  conflictingFields: string[];
  warnings: string[];
};

export type OcrInsightsResponse = {
  fields: Record<string, OcrInsightField>;
  missingFields: string[];
  conflictingFields: string[];
  warnings: string[];
  groupedByDocumentType: Record<string, Record<string, OcrInsightField>>;
  groupedByFieldCategory: Record<string, Record<string, OcrInsightField>>;
};

const NUMERIC_FIELDS = new Set([
  "total_revenue",
  "net_income",
  "cash_on_hand",
  "accounts_receivable",
  "accounts_payable",
  "inventory_value",
  "equipment_value",
]);

const NUMERIC_RELATIVE_TOLERANCE = 0.01;
const NUMERIC_ABSOLUTE_TOLERANCE = 1;

function normalizeTextValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseNumericValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed
    .replace(/\(([^)]+)\)/g, "-$1")
    .replace(/[^0-9.-]/g, "")
    .replace(/(\..*)\./g, "$1");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function valuesWithinTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  const tolerance = Math.max(NUMERIC_ABSOLUTE_TOLERANCE, scale * NUMERIC_RELATIVE_TOLERANCE);
  return diff <= tolerance;
}

function isNumericField(field: OcrFieldDefinition | undefined): boolean {
  if (!field) {
    return false;
  }
  return NUMERIC_FIELDS.has(field.field_key);
}

function toSortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function analyzeOcrFields(params: {
  entries: Array<{
    fieldKey: string;
    value: string;
  }>;
}): OcrInsightsSummary {
  const registry = fetchOcrFieldRegistry();
  const valuesByField = new Map<string, string[]>();

  params.entries.forEach((entry) => {
    const normalized = normalizeTextValue(entry.value);
    if (!normalized) {
      return;
    }
    const existing = valuesByField.get(entry.fieldKey) ?? [];
    existing.push(normalized);
    valuesByField.set(entry.fieldKey, existing);
  });

  const missingFields: string[] = [];
  const conflictingFields: string[] = [];
  const warnings: string[] = [];

  registry.forEach((field) => {
    const values = valuesByField.get(field.field_key) ?? [];
    if (field.required && values.length === 0) {
      missingFields.push(field.field_key);
      warnings.push(`Missing ${field.display_label}`);
      return;
    }

    if (values.length > 1) {
      const numeric = isNumericField(field);
      if (numeric) {
        const uniqueGroups: number[] = [];
        values.forEach((value) => {
          const parsed = parseNumericValue(value);
          if (parsed === null) {
            return;
          }
          if (!uniqueGroups.some((existing) => valuesWithinTolerance(existing, parsed))) {
            uniqueGroups.push(parsed);
          }
        });
        if (uniqueGroups.length > 1) {
          conflictingFields.push(field.field_key);
          warnings.push(`Conflicting ${field.display_label}`);
        }
      } else {
        const unique = toSortedUnique(values);
        if (unique.length > 1) {
          conflictingFields.push(field.field_key);
          warnings.push(`Conflicting ${field.display_label}`);
        }
      }
    }
  });

  const complete = missingFields.length === 0 && conflictingFields.length === 0;
  return {
    complete,
    missingFields: toSortedUnique(missingFields),
    conflictingFields: toSortedUnique(conflictingFields),
    warnings: toSortedUnique(warnings),
  };
}

export async function analyzeOcrForApplication(
  applicationId: string
): Promise<OcrInsightsSummary> {
  const rows = await listOcrFieldsForApplication(applicationId);
  return analyzeOcrFields({
    entries: rows.map((row) => ({
      fieldKey: row.field_key,
      value: row.value,
    })),
  });
}

function fetchFieldCategories(field: OcrFieldDefinition): string[] {
  if (field.applies_to === "all") {
    return ["general"];
  }
  return field.applies_to.length > 0 ? field.applies_to : ["general"];
}

export async function fetchOcrInsightsForApplication(
  applicationId: string
): Promise<OcrInsightsResponse> {
  const rows = await listOcrFieldsForApplication(applicationId);
  const summary = analyzeOcrFields({
    entries: rows.map((row) => ({ fieldKey: row.field_key, value: row.value })),
  });

  const fields: Record<string, OcrInsightField> = {};
  const groupedByDocumentType: Record<string, Record<string, OcrInsightField>> = {};

  rows.forEach((row) => {
    const existing = fields[row.field_key];
    const source: OcrFieldSource = {
      documentId: row.document_id,
      documentType: row.source_document_type ?? null,
      page: null,
    };
    if (!existing) {
      fields[row.field_key] = {
        value: row.value,
        confidence: row.confidence,
        sources: [source],
      };
    } else {
      existing.sources.push(source);
      if (row.confidence > existing.confidence) {
        existing.value = row.value;
        existing.confidence = row.confidence;
      }
    }

    const docType = row.source_document_type ?? "unknown";
    if (!groupedByDocumentType[docType]) {
      groupedByDocumentType[docType] = {};
    }
    const documentGroup = groupedByDocumentType[docType];
    const documentExisting = documentGroup[row.field_key];
    if (!documentExisting || row.confidence > documentExisting.confidence) {
      documentGroup[row.field_key] = {
        value: row.value,
        confidence: row.confidence,
        sources: [source],
      };
    }
  });

  const groupedByFieldCategory: Record<string, Record<string, OcrInsightField>> = {};
  const registry = fetchOcrFieldRegistry();
  const registryByKey = new Map(registry.map((field) => [field.field_key, field]));

  Object.entries(fields).forEach(([fieldKey, insight]) => {
    const field = registryByKey.get(fieldKey);
    if (!field) {
      return;
    }
    const normalizedValue = normalizeTextValue(insight.value);
    if (normalizedValue) {
      insight.value = normalizedValue;
    }
    const categories = fetchFieldCategories(field);
    categories.forEach((category) => {
      if (!groupedByFieldCategory[category]) {
        groupedByFieldCategory[category] = {};
      }
      groupedByFieldCategory[category][fieldKey] = insight;
    });
  });

  Object.values(groupedByDocumentType).forEach((documentGroup) => {
    Object.values(documentGroup).forEach((insight) => {
      const normalizedValue = normalizeTextValue(insight.value);
      if (normalizedValue) {
        insight.value = normalizedValue;
      }
    });
  });

  return {
    fields,
    missingFields: summary.missingFields,
    conflictingFields: summary.conflictingFields,
    warnings: summary.warnings,
    groupedByDocumentType,
    groupedByFieldCategory,
  };
}

export function isNumericOcrField(fieldKey: string): boolean {
  return isNumericField(fetchOcrFieldDefinitionByKey(fieldKey));
}

export async function refreshOcrInsightsForApplication(
  applicationId: string
): Promise<OcrInsightsResponse> {
  const insights = await fetchOcrInsightsForApplication(applicationId);
  const normalizedValues: Record<string, string> = {};
  Object.entries(insights.fields).forEach(([key, field]) => {
    const normalized = normalizeTextValue(field.value);
    if (normalized) {
      normalizedValues[key] = normalized;
    }
  });
  await updateApplicationOcrInsights({
    applicationId,
    missingFields: insights.missingFields,
    conflictingFields: insights.conflictingFields,
    normalizedValues,
  });
  return insights;
}
