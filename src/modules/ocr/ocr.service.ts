import { AppError } from "../../middleware/errors";
import { recordAuditEvent } from "../audit/audit.service";
import { runtimeEnv } from "src/server/config/config";
import {
  findApplicationById,
  findDocumentById,
  findActiveDocumentVersion,
  listDocumentsByApplicationId,
} from "../applications/applications.repo";
import {
  createOcrJob,
  findOcrJobByDocumentId,
  findOcrResultByDocumentId,
  insertDocumentOcrFields,
  markOcrJobFailure,
  markOcrJobSuccess,
  resetOcrJob,
} from "./ocr.repo";
import { createOpenAiOcrProvider, type OcrProvider } from "./ocr.provider";
import { createOcrStorage, OcrStorageValidationError, type OcrStorage } from "./ocr.storage";
import { type OcrJobRecord } from "./ocr.types";
import { logError, logInfo } from "../../observability/logger";
import { getOcrFieldRegistry, type OcrFieldDefinition } from "./ocrFieldRegistry";
import {
  isNumericOcrField,
  refreshOcrInsightsForApplication,
} from "../applications/ocr/ocrAnalysis.service";
import { notifyOcrWarnings } from "../notifications/ocrNotifications.service";

const OCR_RETRY_BASE_MS = 1000;
const OCR_RETRY_MAX_MS = 15 * 60 * 1000;
const OCR_FUZZY_THRESHOLD = 0.85;

function resolveProvider(): OcrProvider {
  const provider = runtimeEnv.ocrProvider;
  if (provider === "openai") {
    return createOpenAiOcrProvider();
  }
  throw new Error(`unsupported_ocr_provider:${provider}`);
}

function parseMetadata(metadata: unknown): { mimeType: string; fileName?: string } {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("missing_document_metadata");
  }
  const record = metadata as { mimeType?: unknown; fileName?: unknown };
  if (!record.mimeType || typeof record.mimeType !== "string") {
    throw new Error("missing_document_mime_type");
  }
  const result: { mimeType: string; fileName?: string } = {
    mimeType: record.mimeType,
  };
  if (typeof record.fileName === "string") {
    result.fileName = record.fileName;
  }
  return result;
}

function computeNextAttempt(attemptCount: number, maxAttempts: number): Date | null {
  const nextAttempt = attemptCount + 1;
  if (nextAttempt >= maxAttempts) {
    return null;
  }
  const delay = Math.min(OCR_RETRY_BASE_MS * 2 ** attemptCount, OCR_RETRY_MAX_MS);
  return new Date(Date.now() + delay);
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaroWinkler(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0 || bLen === 0) {
    return 0;
  }
  const matchDistance = Math.floor(Math.max(aLen, bLen) / 2) - 1;
  const aMatches = new Array(aLen).fill(false);
  const bMatches = new Array(bLen).fill(false);
  let matches = 0;

  for (let i = 0; i < aLen; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, bLen);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j]) continue;
      if (a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }

  if (matches === 0) {
    return 0;
  }

  let t = 0;
  let k = 0;
  for (let i = 0; i < aLen; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) {
      k += 1;
    }
    if (a[i] !== b[k]) {
      t += 1;
    }
    k += 1;
  }

  const transpositions = t / 2;
  const jaro =
    (matches / aLen + matches / bLen + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, aLen, bLen); i += 1) {
    if (a[i] === b[i]) {
      prefix += 1;
    } else {
      break;
    }
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

function extractValueFromLine(line: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escaped}\\s*[:\-]?\\s*(.+)$`, "i");
  const match = line.match(regex);
  if (match && match[1]) {
    const value = match[1].trim();
    return value.length > 0 ? value : null;
  }
  const parts = line.split(/[:\-]/);
  if (parts.length > 1) {
    const value = parts.slice(1).join(":").trim();
    return value.length > 0 ? value : null;
  }
  const tokens = line.trim().split(/\s+/);
  if (tokens.length > 1) {
    return tokens.slice(1).join(" ");
  }
  return null;
}

function parseNumericValue(value: string): string {
  const normalized = value
    .replace(/\(([^)]+)\)/g, "-$1")
    .replace(/[^0-9.-]/g, "")
    .replace(/(\..*)\./g, "$1");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    return value.trim();
  }
  return parsed.toString();
}

function extractFieldsFromText(text: string, registry: OcrFieldDefinition[]): Array<{
  fieldKey: string;
  value: string;
  confidence: number;
  page: number | null;
}> {
  const normalizedText = normalizeText(text);
  const lines = normalizedText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const results: Array<{
    fieldKey: string;
    value: string;
    confidence: number;
    page: number | null;
  }> = [];

  registry.forEach((field) => {
    const candidateLabels = Array.from(
      new Set([field.display_label, ...(field.aliases ?? [])])
    ).filter((label) => typeof label === "string" && label.trim().length > 0);
    if (candidateLabels.length === 0) {
      return;
    }
    let matchedLine: string | null = null;
    let matchedConfidence = 0;
    let matchedLabel: string | null = null;

    candidateLabels.forEach((label) => {
      const labelNormalized = normalizeMatchText(label);
      if (!labelNormalized) {
        return;
      }

      lines.forEach((line) => {
        const normalizedLine = normalizeMatchText(line);
        if (!normalizedLine) {
          return;
        }

        if (normalizedLine.includes(labelNormalized)) {
          if (1 >= matchedConfidence) {
            matchedLine = line;
            matchedConfidence = 1;
            matchedLabel = label;
          }
          return;
        }

        const candidate = (normalizedLine.split(/[:\\-]/)[0] ?? "").trim();
        const similarity = jaroWinkler(labelNormalized, candidate || normalizedLine);
        if (similarity >= OCR_FUZZY_THRESHOLD) {
          if (!matchedLine || similarity > matchedConfidence) {
            matchedLine = line;
            matchedConfidence = similarity;
            matchedLabel = label;
          }
        }
      });
    });

    if (!matchedLine || !matchedLabel) {
      return;
    }

    const value = extractValueFromLine(matchedLine, matchedLabel);
    if (!value) {
      return;
    }

    const normalizedValue = isNumericOcrField(field.field_key)
      ? parseNumericValue(value)
      : value.trim();

    results.push({
      fieldKey: field.field_key,
      value: normalizedValue,
      confidence: matchedConfidence,
      page: null,
    });
  });

  return results;
}

export function extractOcrFields(text: string): Array<{
  fieldKey: string;
  value: string;
  confidence: number;
  page: number | null;
}> {
  return extractFieldsFromText(text, getOcrFieldRegistry());
}

export async function enqueueOcrForDocument(documentId: string): Promise<OcrJobRecord> {
  const document = await findDocumentById(documentId);
  if (!document) {
    throw new AppError("not_found", "Document not found.", 404);
  }
  return createOcrJob({
    documentId: document.id,
    applicationId: document.application_id,
    maxAttempts: runtimeEnv.ocrMaxAttempts,
  });
}

export async function enqueueOcrForApplication(applicationId: string): Promise<OcrJobRecord[]> {
  const application = await findApplicationById(applicationId);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }
  const documents = await listDocumentsByApplicationId(applicationId);
  const jobs: OcrJobRecord[] = [];
  for (const document of documents) {
    const job = await createOcrJob({
      documentId: document.id,
      applicationId: document.application_id,
      maxAttempts: runtimeEnv.ocrMaxAttempts,
    });
    jobs.push(job);
  }
  return jobs;
}

export async function getOcrJobStatus(documentId: string): Promise<OcrJobRecord | null> {
  return findOcrJobByDocumentId(documentId);
}

export async function getOcrResult(documentId: string): Promise<ReturnType<typeof findOcrResultByDocumentId>> {
  return findOcrResultByDocumentId(documentId);
}

export async function retryOcrJob(documentId: string): Promise<OcrJobRecord> {
  const job = await findOcrJobByDocumentId(documentId);
  if (!job) {
    return enqueueOcrForDocument(documentId);
  }
  const updated = await resetOcrJob({ jobId: job.id });
  if (!updated) {
    throw new AppError("not_found", "OCR job not found.", 404);
  }
  return updated;
}

export async function processOcrJob(
  job: OcrJobRecord,
  options?: { provider?: OcrProvider; storage?: OcrStorage }
): Promise<void> {
  const provider = options?.provider ?? resolveProvider();
  const storage = options?.storage ?? createOcrStorage();
  const maxAttempts = Number.isFinite(job.max_attempts) && job.max_attempts > 0
    ? job.max_attempts
    : runtimeEnv.ocrMaxAttempts;

  logInfo("ocr_job_started", {
    jobId: job.id,
    documentId: job.document_id,
    applicationId: job.application_id,
  });

  try {
    const document = await findDocumentById(job.document_id);
    if (!document) {
      throw new Error("document_not_found");
    }
    const version = await findActiveDocumentVersion({ documentId: document.id });
    if (!version) {
      throw new Error("document_version_missing");
    }
    const { mimeType, fileName } = parseMetadata(version.metadata);
    const buffer = await storage.getBuffer({ content: version.content });
    const extractPayload = {
      buffer,
      mimeType,
      ...(fileName ? { fileName } : {}),
    };
    const result = await provider.extract(extractPayload);
    await markOcrJobSuccess({
      jobId: job.id,
      documentId: job.document_id,
      provider: result.provider,
      model: result.model,
      extractedText: result.text,
      extractedJson: result.json,
      meta: result.meta,
    });

    const extractedFields = extractOcrFields(result.text);

    try {
      await insertDocumentOcrFields({
        documentId: job.document_id,
        applicationId: job.application_id,
        documentType: document.document_type ?? null,
        fields: extractedFields,
      });
    } catch (insertError) {
      logError("ocr_field_insert_failed", {
        code: "ocr_field_insert_failed",
        documentId: job.document_id,
        applicationId: job.application_id,
        error: insertError instanceof Error ? insertError.message : "unknown_error",
      });
    }

    try {
      const summary = await refreshOcrInsightsForApplication(job.application_id);
      await notifyOcrWarnings({
        applicationId: job.application_id,
        missingFields: summary.missingFields,
        conflictingFields: summary.conflictingFields,
      });
    } catch (insightError) {
      logError("ocr_insights_refresh_failed", {
        code: "ocr_insights_refresh_failed",
        applicationId: job.application_id,
        error: insightError instanceof Error ? insightError.message : "unknown_error",
      });
    }

    logInfo("ocr_job_succeeded", {
      jobId: job.id,
      documentId: job.document_id,
      applicationId: job.application_id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (error instanceof OcrStorageValidationError) {
      logError("ocr_storage_url_rejected", {
        code: "ocr_storage_url_rejected",
        jobId: job.id,
        documentId: job.document_id,
        url: error.url,
      });
      try {
        await recordAuditEvent({
          action: "ocr_storage_url_rejected",
          actorUserId: null,
          targetUserId: null,
          targetType: "ocr_job",
          targetId: job.id,
          success: false,
        });
      } catch (auditError) {
        logError("ocr_storage_url_audit_failed", {
          code: "ocr_storage_url_audit_failed",
          jobId: job.id,
          error: auditError instanceof Error ? auditError.message : "unknown_error",
        });
      }
    }
    const attemptCount = job.attempt_count + 1;
    const status = attemptCount >= maxAttempts ? "canceled" : "failed";
    const nextAttemptAt =
      status === "canceled" ? null : computeNextAttempt(job.attempt_count, maxAttempts);
    await markOcrJobFailure({
      jobId: job.id,
      attemptCount,
      status,
      lastError: message,
      nextAttemptAt,
      maxAttempts,
    });
    logError("ocr_job_failed", {
      code: "ocr_job_failed",
      jobId: job.id,
      documentId: job.document_id,
      applicationId: job.application_id,
      error: message,
    });
  }
}
