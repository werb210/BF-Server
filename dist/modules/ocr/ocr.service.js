"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractOcrFields = extractOcrFields;
exports.enqueueOcrForDocument = enqueueOcrForDocument;
exports.enqueueOcrForApplication = enqueueOcrForApplication;
exports.fetchOcrJobStatus = fetchOcrJobStatus;
exports.fetchOcrResult = fetchOcrResult;
exports.retryOcrJob = retryOcrJob;
exports.processOcrJob = processOcrJob;
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const config_1 = require("../../config");
const applications_repo_1 = require("../applications/applications.repo");
const ocr_repo_1 = require("./ocr.repo");
const ocr_provider_1 = require("./ocr.provider");
const ocr_storage_1 = require("./ocr.storage");
const logger_1 = require("../../observability/logger");
const ocrFieldRegistry_1 = require("./ocrFieldRegistry");
const ocrAnalysis_service_1 = require("../applications/ocr/ocrAnalysis.service");
const ocrNotifications_service_1 = require("../notifications/ocrNotifications.service");
const OCR_RETRY_BASE_MS = 1000;
const OCR_RETRY_MAX_MS = 15 * 60 * 1000;
const OCR_FUZZY_THRESHOLD = 0.85;
function resolveProvider() {
    const provider = config_1.config.ocr.provider;
    if (provider === "openai") {
        return (0, ocr_provider_1.createOpenAiOcrProvider)();
    }
    throw new Error(`unsupported_ocr_provider:${provider}`);
}
function parseMetadata(metadata) {
    if (!metadata || typeof metadata !== "object") {
        throw new Error("missing_document_metadata");
    }
    const record = metadata;
    if (!record.mimeType || typeof record.mimeType !== "string") {
        throw new Error("missing_document_mime_type");
    }
    const result = {
        mimeType: record.mimeType,
    };
    if (typeof record.fileName === "string") {
        result.fileName = record.fileName;
    }
    return result;
}
function computeNextAttempt(attemptCount, maxAttempts) {
    const nextAttempt = attemptCount + 1;
    if (nextAttempt >= maxAttempts) {
        return null;
    }
    const delay = Math.min(OCR_RETRY_BASE_MS * 2 ** attemptCount, OCR_RETRY_MAX_MS);
    return new Date(Date.now() + delay);
}
function normalizeText(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function normalizeMatchText(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function jaroWinkler(a, b) {
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
            if (bMatches[j])
                continue;
            if (a[i] !== b[j])
                continue;
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
        if (!aMatches[i])
            continue;
        while (!bMatches[k]) {
            k += 1;
        }
        if (a[i] !== b[k]) {
            t += 1;
        }
        k += 1;
    }
    const transpositions = t / 2;
    const jaro = (matches / aLen + matches / bLen + (matches - transpositions) / matches) / 3;
    let prefix = 0;
    for (let i = 0; i < Math.min(4, aLen, bLen); i += 1) {
        if (a[i] === b[i]) {
            prefix += 1;
        }
        else {
            break;
        }
    }
    return jaro + prefix * 0.1 * (1 - jaro);
}
function extractValueFromLine(line, label) {
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
function parseNumericValue(value) {
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
function extractFieldsFromText(text, registry) {
    const normalizedText = normalizeText(text);
    const lines = normalizedText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const results = [];
    registry.forEach((field) => {
        const candidateLabels = Array.from(new Set([field.display_label, ...(field.aliases ?? [])])).filter((label) => typeof label === "string" && label.trim().length > 0);
        if (candidateLabels.length === 0) {
            return;
        }
        let matchedLine = null;
        let matchedConfidence = 0;
        let matchedLabel = null;
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
        const normalizedValue = (0, ocrAnalysis_service_1.isNumericOcrField)(field.field_key)
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
function extractOcrFields(text) {
    return extractFieldsFromText(text, (0, ocrFieldRegistry_1.fetchOcrFieldRegistry)());
}
async function enqueueOcrForDocument(documentId) {
    const document = await (0, applications_repo_1.findDocumentById)(documentId);
    if (!document) {
        throw new errors_1.AppError("not_found", "Document not found.", 404);
    }
    return (0, ocr_repo_1.createOcrJob)({
        documentId: document.id,
        applicationId: document.application_id,
        maxAttempts: config_1.config.ocr.maxAttempts,
    });
}
async function enqueueOcrForApplication(applicationId) {
    const application = await (0, applications_repo_1.findApplicationById)(applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    const documents = await (0, applications_repo_1.listDocumentsByApplicationId)(applicationId);
    const jobs = [];
    for (const document of documents) {
        const job = await (0, ocr_repo_1.createOcrJob)({
            documentId: document.id,
            applicationId: document.application_id,
            maxAttempts: config_1.config.ocr.maxAttempts,
        });
        jobs.push(job);
    }
    return jobs;
}
async function fetchOcrJobStatus(documentId) {
    return (0, ocr_repo_1.findOcrJobByDocumentId)(documentId);
}
async function fetchOcrResult(documentId) {
    return (0, ocr_repo_1.findOcrResultByDocumentId)(documentId);
}
async function retryOcrJob(documentId) {
    const job = await (0, ocr_repo_1.findOcrJobByDocumentId)(documentId);
    if (!job) {
        return enqueueOcrForDocument(documentId);
    }
    const updated = await (0, ocr_repo_1.resetOcrJob)({ jobId: job.id });
    if (!updated) {
        throw new errors_1.AppError("not_found", "OCR job not found.", 404);
    }
    return updated;
}
async function processOcrJob(job, options) {
    const provider = options?.provider ?? resolveProvider();
    const storage = options?.storage ?? (0, ocr_storage_1.createOcrStorage)();
    const maxAttempts = Number.isFinite(job.max_attempts) && job.max_attempts > 0
        ? job.max_attempts
        : config_1.config.ocr.maxAttempts;
    (0, logger_1.logInfo)("ocr_job_started", {
        jobId: job.id,
        documentId: job.document_id,
        applicationId: job.application_id,
    });
    try {
        const document = await (0, applications_repo_1.findDocumentById)(job.document_id);
        if (!document) {
            throw new Error("document_not_found");
        }
        const version = await (0, applications_repo_1.findActiveDocumentVersion)({ documentId: document.id });
        if (!version) {
            throw new Error("document_version_missing");
        }
        const { mimeType, fileName } = parseMetadata(version.metadata);
        const buffer = await storage.fetchBuffer({ content: version.content });
        const extractPayload = {
            buffer,
            mimeType,
            ...(fileName ? { fileName } : {}),
        };
        const result = await provider.extract(extractPayload);
        await (0, ocr_repo_1.markOcrJobSuccess)({
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
            await (0, ocr_repo_1.insertDocumentOcrFields)({
                documentId: job.document_id,
                applicationId: job.application_id,
                documentType: document.document_type ?? null,
                fields: extractedFields,
            });
        }
        catch (insertError) {
            (0, logger_1.logError)("ocr_field_insert_failed", {
                code: "ocr_field_insert_failed",
                documentId: job.document_id,
                applicationId: job.application_id,
                error: insertError instanceof Error ? insertError.message : "unknown_error",
            });
        }
        try {
            const summary = await (0, ocrAnalysis_service_1.refreshOcrInsightsForApplication)(job.application_id);
            await (0, ocrNotifications_service_1.notifyOcrWarnings)({
                applicationId: job.application_id,
                missingFields: summary.missingFields,
                conflictingFields: summary.conflictingFields,
            });
        }
        catch (insightError) {
            (0, logger_1.logError)("ocr_insights_refresh_failed", {
                code: "ocr_insights_refresh_failed",
                applicationId: job.application_id,
                error: insightError instanceof Error ? insightError.message : "unknown_error",
            });
        }
        (0, logger_1.logInfo)("ocr_job_succeeded", {
            jobId: job.id,
            documentId: job.document_id,
            applicationId: job.application_id,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "unknown_error";
        if (error instanceof ocr_storage_1.OcrStorageValidationError) {
            (0, logger_1.logError)("ocr_storage_url_rejected", {
                code: "ocr_storage_url_rejected",
                jobId: job.id,
                documentId: job.document_id,
                url: error.url,
            });
            try {
                await (0, audit_service_1.recordAuditEvent)({
                    action: "ocr_storage_url_rejected",
                    actorUserId: null,
                    targetUserId: null,
                    targetType: "ocr_job",
                    targetId: job.id,
                    success: false,
                });
            }
            catch (auditError) {
                (0, logger_1.logError)("ocr_storage_url_audit_failed", {
                    code: "ocr_storage_url_audit_failed",
                    jobId: job.id,
                    error: auditError instanceof Error ? auditError.message : "unknown_error",
                });
            }
        }
        const attemptCount = job.attempt_count + 1;
        const status = attemptCount >= maxAttempts ? "canceled" : "failed";
        const nextAttemptAt = status === "canceled" ? null : computeNextAttempt(job.attempt_count, maxAttempts);
        await (0, ocr_repo_1.markOcrJobFailure)({
            jobId: job.id,
            attemptCount,
            status,
            lastError: message,
            nextAttemptAt,
            maxAttempts,
        });
        (0, logger_1.logError)("ocr_job_failed", {
            code: "ocr_job_failed",
            jobId: job.id,
            documentId: job.document_id,
            applicationId: job.application_id,
            error: message,
        });
    }
}
