"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.transitionPipelineState = transitionPipelineState;
exports.createApplicationForUser = createApplicationForUser;
exports.openApplicationForStaff = openApplicationForStaff;
exports.listDocumentsForApplication = listDocumentsForApplication;
exports.fetchProcessingStatus = fetchProcessingStatus;
exports.removeDocument = removeDocument;
exports.markCreditSummaryCompleted = markCreditSummaryCompleted;
exports.uploadDocument = uploadDocument;
exports.changePipelineState = changePipelineState;
exports.acceptDocumentVersion = acceptDocumentVersion;
exports.rejectDocumentVersion = rejectDocumentVersion;
exports.acceptDocument = acceptDocument;
exports.rejectDocument = rejectDocument;
exports.fetchPipelineStates = fetchPipelineStates;
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const applications_repo_1 = require("./applications.repo");
const db_1 = require("../../db");
const roles_1 = require("../../auth/roles");
const pipelineState_1 = require("./pipelineState");
const applicationLifecycle_service_1 = require("./applicationLifecycle.service");
const config_1 = require("../../config");
const transactionTelemetry_1 = require("../../observability/transactionTelemetry");
const lenderProductRequirementsService_1 = require("../../services/lenderProductRequirementsService");
const blobStorage_1 = require("../../services/storage/blobStorage");
const fileValidation_1 = require("../../utils/fileValidation");
const requiredDocuments_1 = require("../../db/schema/requiredDocuments");
const processingStage_service_1 = require("./processingStage.service");
const processing_service_1 = require("../processing/processing.service");
const BANK_STATEMENT_CATEGORY = "bank_statements_6_months";
const EMPTY_OCR_INSIGHTS = {
    fields: {},
    missingFields: [],
    conflictingFields: [],
    warnings: [],
    groupedByDocumentType: {},
    groupedByFieldCategory: {},
};
function buildRequestMetadata(params) {
    const metadata = {};
    if (params.ip) {
        metadata.ip = params.ip;
    }
    if (params.userAgent) {
        metadata.userAgent = params.userAgent;
    }
    return metadata;
}
function resolveApplicationCountry(metadata) {
    if (!metadata || typeof metadata !== "object") {
        return null;
    }
    const business = metadata.business;
    if (!business || typeof business !== "object") {
        return null;
    }
    const address = business.address;
    if (!address || typeof address !== "object") {
        return null;
    }
    const country = address.country;
    return typeof country === "string" && country.trim().length > 0
        ? country.trim()
        : null;
}
function toIsoString(value) {
    if (!value) {
        return null;
    }
    return value.toISOString();
}
function normalizeDocumentStatus(status) {
    return DOCUMENT_STATUS_VALUES.has(status)
        ? status
        : "missing";
}
const DEFAULT_PIPELINE_STAGE = pipelineState_1.ApplicationStage.RECEIVED;
const STAFF_REVIEW_ROLES = new Set([
    roles_1.ROLES.ADMIN,
    roles_1.ROLES.STAFF,
    roles_1.ROLES.OPS,
]);
const DOCUMENT_STATUS_VALUES = new Set([
    "missing",
    "uploaded",
    "accepted",
    "rejected",
]);
function normalizePipelineStage(stage) {
    return stage ?? DEFAULT_PIPELINE_STAGE;
}
function assertMetadata(value) {
    if (!value || typeof value !== "object") {
        throw new errors_1.AppError("invalid_metadata", "Metadata is required.", 400);
    }
    const record = value;
    if (typeof record.fileName !== "string" ||
        typeof record.mimeType !== "string" ||
        typeof record.size !== "number") {
        throw new errors_1.AppError("invalid_metadata", "Metadata is invalid.", 400);
    }
}
function validateDocumentMetadata(metadata) {
    const allowed = config_1.config.documents.allowedMimeTypes;
    if (!allowed.includes(metadata.mimeType)) {
        throw new errors_1.AppError("invalid_mime_type", "Unsupported document MIME type.", 400);
    }
    const maxSize = config_1.config.documents.maxSizeBytes;
    if (metadata.size > maxSize) {
        throw new errors_1.AppError("document_too_large", "Document exceeds max size.", 400);
    }
}
async function recordDocumentUploadFailure(params) {
    const auditPayload = {
        action: "document_upload_rejected",
        actorUserId: params.actorUserId,
        targetUserId: params.targetUserId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: false,
        ...(params.client ? { client: params.client } : {}),
    };
    await (0, audit_service_1.recordAuditEvent)(auditPayload);
}
function canAccessApplication(role, ownerUserId, actorId) {
    if (ownerUserId && actorId === ownerUserId) {
        return true;
    }
    return role === roles_1.ROLES.ADMIN || role === roles_1.ROLES.STAFF;
}
function resolveUploadedBy(role) {
    return STAFF_REVIEW_ROLES.has(role) ? "staff" : "client";
}
function assertStaffReviewRole(role) {
    if (!STAFF_REVIEW_ROLES.has(role)) {
        throw new errors_1.AppError("forbidden", "Not authorized.", 403);
    }
}
async function ensureRequiredDocuments(params) {
    const existing = await (0, applications_repo_1.listApplicationRequiredDocuments)({
        applicationId: params.application.id,
        ...(params.client ? { client: params.client } : {}),
    });
    const existingMap = new Map(existing.map((entry) => [entry.document_category, entry]));
    return params.requirements.map((requirement) => {
        const key = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(requirement.documentType);
        const documentCategory = key ?? requirement.documentType;
        const match = existingMap.get(documentCategory);
        if (match) {
            return match;
        }
        return {
            id: `missing-${documentCategory}`,
            application_id: params.application.id,
            document_category: documentCategory,
            is_required: requirement.required !== false,
            status: "missing",
            created_at: new Date(0),
        };
    });
}
async function resolveRequirementForDocument(params) {
    const { requirements } = await (0, lenderProductRequirementsService_1.resolveRequirementsForApplication)({
        lenderProductId: params.application.lender_product_id ?? null,
        productType: params.application.product_type,
        requestedAmount: params.application.requested_amount ?? null,
        country: resolveApplicationCountry(params.application.metadata),
    });
    const normalizedRequested = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(params.documentType);
    const requirement = requirements.find((item) => {
        const normalizedRequirement = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(item.documentType);
        return normalizedRequirement && normalizedRequested
            ? normalizedRequirement === normalizedRequested
            : item.documentType === params.documentType;
    });
    return {
        documentCategory: normalizedRequested ?? params.documentType,
        isRequired: requirement?.required !== false,
    };
}
async function enforceDocumentsRequiredStage(params) {
    if (params.application.pipeline_state !== pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) {
        await transitionPipelineState({
            applicationId: params.application.id,
            nextState: pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            trigger: params.trigger,
            ...(params.client ? { client: params.client } : {}),
        });
        return;
    }
}
async function transitionPipelineState(params) {
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, params.client);
    if (!application) {
        const auditPayload = {
            action: "pipeline_state_changed",
            actorUserId: params.actorUserId,
            targetUserId: null,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
            ...(params.client ? { client: params.client } : {}),
        };
        await (0, audit_service_1.recordAuditEvent)(auditPayload);
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (params.actorUserId && params.actorRole) {
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            const auditPayload = {
                action: "pipeline_state_changed",
                actorUserId: params.actorUserId,
                targetUserId: application.owner_user_id,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: false,
                ...(params.client ? { client: params.client } : {}),
            };
            await (0, audit_service_1.recordAuditEvent)(auditPayload);
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
    }
    const currentStage = (0, applicationLifecycle_service_1.assertPipelineState)(application.pipeline_state);
    let transition;
    try {
        transition = (0, applicationLifecycle_service_1.assertPipelineTransition)({
            currentStage,
            nextStage: params.nextState,
        });
    }
    catch (error) {
        const auditPayload = {
            action: "pipeline_state_changed",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
            ...(params.client ? { client: params.client } : {}),
        };
        await (0, audit_service_1.recordAuditEvent)(auditPayload);
        throw error;
    }
    if (!transition.shouldTransition) {
        return;
    }
    await (0, applications_repo_1.updateApplicationPipelineState)({
        applicationId: params.applicationId,
        pipelineState: params.nextState,
        ...(params.client ? { client: params.client } : {}),
    });
    await (0, applications_repo_1.createApplicationStageEvent)({
        applicationId: params.applicationId,
        fromStage: currentStage,
        toStage: params.nextState,
        trigger: params.trigger,
        triggeredBy: params.actorUserId ?? "system",
        reason: params.reason ?? null,
        ...(params.client ? { client: params.client } : {}),
    });
    const auditSuccessPayload = {
        action: "pipeline_state_changed",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        ...(params.client ? { client: params.client } : {}),
    };
    await (0, audit_service_1.recordAuditEvent)(auditSuccessPayload);
    const auditStagePayload = {
        action: "pipeline_stage_changed",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        targetType: "application",
        targetId: params.applicationId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
            from: currentStage,
            to: params.nextState,
        },
        ...(params.client ? { client: params.client } : {}),
    };
    await (0, audit_service_1.recordAuditEvent)(auditStagePayload);
}
async function evaluateRequirements(params) {
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, params.client);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!(0, pipelineState_1.isPipelineState)(application.pipeline_state)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    const { requirements } = await (0, lenderProductRequirementsService_1.resolveRequirementsForApplication)({
        lenderProductId: application.lender_product_id ?? null,
        productType: application.product_type,
        requestedAmount: application.requested_amount ?? null,
        country: resolveApplicationCountry(application.metadata),
    });
    const requiredDocuments = await ensureRequiredDocuments({
        application,
        requirements,
        ...(params.client ? { client: params.client } : {}),
    });
    const missingRequired = requiredDocuments.some((doc) => {
        if (!doc.is_required) {
            return false;
        }
        return doc.status !== "accepted";
    });
    if (missingRequired && application.pipeline_state === pipelineState_1.ApplicationStage.RECEIVED) {
        await transitionPipelineState({
            applicationId: application.id,
            nextState: pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            trigger: "requirements_missing",
            ...(params.ip ? { ip: params.ip } : {}),
            ...(params.userAgent ? { userAgent: params.userAgent } : {}),
            ...(params.client ? { client: params.client } : {}),
        });
    }
    return { missingRequired };
}
async function createApplicationForUser(params) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        await client.runQuery("select id from users where id = $1 for update", [
            params.ownerUserId,
        ]);
        const application = await (0, applications_repo_1.createApplication)({
            ownerUserId: params.ownerUserId,
            name: params.name,
            metadata: params.metadata,
            productType: params.productType ?? "standard",
            trigger: "application_created",
            triggeredBy: params.actorUserId ?? "system",
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "application_created",
            actorUserId: params.actorUserId,
            targetUserId: params.ownerUserId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await evaluateRequirements({
            applicationId: application.id,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole ?? (params.actorUserId ? roles_1.ROLES.REFERRER : null),
            ...buildRequestMetadata(params),
            client,
        });
        const updated = await (0, applications_repo_1.findApplicationById)(application.id, client);
        if (!updated) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        const response = {
            id: updated.id,
            ownerUserId: updated.owner_user_id,
            name: updated.name,
            metadata: updated.metadata,
            productType: updated.product_type,
            pipelineState: normalizePipelineStage(updated.pipeline_state),
            lenderId: updated.lender_id ?? null,
            lenderProductId: updated.lender_product_id ?? null,
            requestedAmount: updated.requested_amount ?? null,
            createdAt: updated.created_at,
            updatedAt: updated.updated_at,
            ocrInsights: EMPTY_OCR_INSIGHTS,
        };
        await client.runQuery("commit");
        return { status: 201, value: response, idempotent: false };
    }
    catch (err) {
        (0, transactionTelemetry_1.recordTransactionRollback)(err);
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function openApplicationForStaff(params) {
    if (params.actorRole !== roles_1.ROLES.ADMIN && params.actorRole !== roles_1.ROLES.STAFF) {
        throw new errors_1.AppError("forbidden", "Not authorized.", 403);
    }
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, client);
        if (!application) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
        if (!(0, pipelineState_1.isPipelineState)(application.pipeline_state)) {
            throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
        }
        const didOpen = await (0, applications_repo_1.updateApplicationFirstOpenedAt)({
            applicationId: params.applicationId,
            client,
        });
        if (didOpen && application.pipeline_state === pipelineState_1.ApplicationStage.RECEIVED) {
            await transitionPipelineState({
                applicationId: params.applicationId,
                nextState: pipelineState_1.ApplicationStage.IN_REVIEW,
                actorUserId: params.actorUserId,
                actorRole: params.actorRole,
                trigger: "first_opened",
                ...buildRequestMetadata(params),
                client,
            });
        }
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function listDocumentsForApplication(params) {
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
        throw new errors_1.AppError("forbidden", "Not authorized.", 403);
    }
    const { requirements } = await (0, lenderProductRequirementsService_1.resolveRequirementsForApplication)({
        lenderProductId: application.lender_product_id ?? null,
        productType: application.product_type,
        requestedAmount: application.requested_amount ?? null,
        country: resolveApplicationCountry(application.metadata),
    });
    const requiredDocuments = await ensureRequiredDocuments({
        application,
        requirements,
    });
    const documents = await (0, applications_repo_1.listDocumentsWithLatestVersion)({
        applicationId: params.applicationId,
    });
    const grouped = new Map();
    for (const requirement of requiredDocuments) {
        grouped.set(requirement.document_category, {
            documentCategory: requirement.document_category,
            isRequired: requirement.is_required,
            status: requirement.status,
            documents: [],
        });
    }
    for (const doc of documents) {
        const existing = grouped.get(doc.document_type) ??
            {
                documentCategory: doc.document_type,
                isRequired: false,
                status: "uploaded",
                documents: [],
            };
        existing.documents.push({
            documentId: doc.id,
            title: doc.title,
            documentType: doc.document_type,
            status: doc.status,
            filename: doc.filename ?? null,
            storageKey: doc.storage_key ?? null,
            uploadedBy: doc.uploaded_by,
            rejectionReason: doc.rejection_reason ?? null,
            createdAt: doc.created_at,
            updatedAt: doc.updated_at,
            latestVersion: doc.version_id && doc.version !== null
                ? {
                    id: doc.version_id,
                    version: doc.version,
                    metadata: doc.metadata ?? null,
                    reviewStatus: doc.review_status ?? null,
                }
                : null,
        });
        grouped.set(doc.document_type, existing);
    }
    return Array.from(grouped.values()).sort((a, b) => a.documentCategory.localeCompare(b.documentCategory));
}
async function fetchProcessingStatus(applicationId) {
    const application = await (0, applications_repo_1.findApplicationById)(applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    const { requirements } = await (0, lenderProductRequirementsService_1.resolveRequirementsForApplication)({
        lenderProductId: application.lender_product_id ?? null,
        productType: application.product_type,
        requestedAmount: application.requested_amount ?? null,
        country: resolveApplicationCountry(application.metadata),
    });
    const requiredDocuments = new Set();
    for (const requirement of requirements) {
        if (requirement.required === false) {
            continue;
        }
        const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(requirement.documentType);
        if (normalized) {
            requiredDocuments.add(normalized);
        }
    }
    const requiredEntries = await (0, applications_repo_1.listApplicationRequiredDocuments)({ applicationId });
    const requiredMap = {};
    for (const key of requiredDocuments) {
        requiredMap[key] = { status: "missing", updatedAt: null };
    }
    for (const entry of requiredEntries) {
        if (!entry.is_required) {
            continue;
        }
        const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(entry.document_category);
        if (!normalized) {
            continue;
        }
        requiredDocuments.add(normalized);
        requiredMap[normalized] = {
            status: normalizeDocumentStatus(entry.status),
            updatedAt: toIsoString(entry.created_at),
        };
    }
    const allAccepted = Object.values(requiredMap).every((document) => document.status === "accepted");
    const stageFlags = (0, processingStage_service_1.fetchProcessingStageFlags)(application.processing_stage);
    return {
        applicationId: application.id,
        status: {
            ocr: {
                completed: stageFlags.ocrCompleted,
                completedAt: stageFlags.ocrCompleted
                    ? toIsoString(application.ocr_completed_at)
                    : null,
            },
            banking: {
                completed: stageFlags.bankingCompleted,
                completedAt: stageFlags.bankingCompleted
                    ? toIsoString(application.banking_completed_at)
                    : null,
            },
            documents: {
                required: requiredMap,
                allAccepted,
            },
            creditSummary: {
                completed: stageFlags.creditSummaryCompleted,
                completedAt: stageFlags.creditSummaryCompleted
                    ? toIsoString(application.credit_summary_completed_at)
                    : null,
            },
        },
    };
}
async function removeDocument(params) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, client);
        if (!application) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
        if (!(0, pipelineState_1.isPipelineState)(application.pipeline_state)) {
            throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
        }
        const document = await (0, applications_repo_1.findDocumentById)(params.documentId, client);
        if (!document || document.application_id !== params.applicationId) {
            throw new errors_1.AppError("not_found", "Document not found.", 404);
        }
        await (0, applications_repo_1.deleteDocumentById)({ documentId: params.documentId, client });
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_deleted",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            targetType: "document",
            targetId: params.documentId,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        const evaluation = await evaluateRequirements({
            applicationId: params.applicationId,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            ...buildRequestMetadata(params),
            client,
        });
        if (evaluation.missingRequired &&
            application.pipeline_state !== pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) {
            await transitionPipelineState({
                applicationId: params.applicationId,
                nextState: pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED,
                actorUserId: params.actorUserId,
                actorRole: params.actorRole,
                trigger: "requirements_missing",
                ...buildRequestMetadata(params),
                client,
            });
        }
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markCreditSummaryCompleted(params) {
    if (params.client) {
        await params.client.runQuery(`update applications
       set credit_summary_completed_at = now(),
           updated_at = now()
       where id = $1`, [params.applicationId]);
        await (0, processingStage_service_1.advanceProcessingStage)({
            applicationId: params.applicationId,
            client: params.client,
        });
        return;
    }
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        await client.runQuery(`update applications
       set credit_summary_completed_at = now(),
           updated_at = now()
       where id = $1`, [params.applicationId]);
        await (0, processingStage_service_1.advanceProcessingStage)({
            applicationId: params.applicationId,
            client,
        });
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function uploadDocument(params) {
    assertMetadata(params.metadata);
    try {
        validateDocumentMetadata(params.metadata);
    }
    catch (err) {
        await recordDocumentUploadFailure({
            actorUserId: params.actorUserId,
            targetUserId: null,
            ...buildRequestMetadata(params),
        });
        throw err;
    }
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId);
    if (!application) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_uploaded",
            actorUserId: params.actorUserId,
            targetUserId: null,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_uploaded",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        throw new errors_1.AppError("forbidden", "Not authorized.", 403);
    }
    if (!(0, pipelineState_1.isPipelineState)(application.pipeline_state)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    const { requirements } = await (0, lenderProductRequirementsService_1.resolveRequirementsForApplication)({
        lenderProductId: application.lender_product_id ?? null,
        productType: application.product_type,
        requestedAmount: application.requested_amount ?? null,
        country: resolveApplicationCountry(application.metadata),
    });
    const requestedType = params.documentType ?? params.title;
    const normalizedRequested = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(requestedType);
    const requirement = requirements.find((item) => {
        const normalizedRequirement = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(item.documentType);
        return normalizedRequirement && normalizedRequested
            ? normalizedRequirement === normalizedRequested
            : item.documentType === requestedType;
    });
    if (!requirement && !normalizedRequested) {
        await recordDocumentUploadFailure({
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ...buildRequestMetadata(params),
        });
        throw new errors_1.AppError("invalid_document_type", "Document type is not allowed.", 400);
    }
    const buffer = Buffer.from(params.content, "base64");
    const detectedType = await (0, fileValidation_1.validateFile)(buffer);
    const uploaded = await (0, blobStorage_1.uploadDocumentBuffer)({
        buffer,
        filename: params.metadata.fileName,
        contentType: detectedType.mime,
    });
    const normalizedCategory = normalizedRequested ?? requestedType;
    const client = await db_1.pool.connect();
    let documentId = params.documentId ?? null;
    let isNewDocument = false;
    try {
        await client.runQuery("begin");
        if (documentId) {
            const existingDoc = await (0, applications_repo_1.findDocumentById)(documentId, client);
            if (!existingDoc || existingDoc.application_id !== params.applicationId) {
                await client.runQuery("rollback");
                throw new errors_1.AppError("not_found", "Document not found.", 404);
            }
            const incomingType = params.documentType ?? existingDoc.document_type;
            const normalizedExisting = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(existingDoc.document_type);
            const normalizedIncoming = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(incomingType);
            if (normalizedExisting &&
                normalizedIncoming
                ? normalizedExisting !== normalizedIncoming
                : existingDoc.document_type !== incomingType) {
                await recordDocumentUploadFailure({
                    actorUserId: params.actorUserId,
                    targetUserId: application.owner_user_id,
                    ...buildRequestMetadata(params),
                    client,
                });
                throw new errors_1.AppError("document_type_mismatch", "Document type mismatch.", 400);
            }
            const accepted = await (0, applications_repo_1.findAcceptedDocumentVersion)({
                documentId,
                client,
            });
            if (accepted) {
                await recordDocumentUploadFailure({
                    actorUserId: params.actorUserId,
                    targetUserId: application.owner_user_id,
                    ...buildRequestMetadata(params),
                    client,
                });
                throw new errors_1.AppError("document_immutable", "Accepted document versions cannot be modified.", 409);
            }
        }
        else {
            const doc = await (0, applications_repo_1.createDocument)({
                applicationId: params.applicationId,
                ownerUserId: application.owner_user_id,
                title: params.title,
                documentType: params.documentType ?? params.title,
                filename: params.metadata.fileName,
                storageKey: uploaded.blobName,
                uploadedBy: resolveUploadedBy(params.actorRole),
                client,
            });
            documentId = doc.id;
            isNewDocument = true;
        }
        const currentVersion = await (0, applications_repo_1.fetchLatestDocumentVersion)(documentId, client);
        const nextVersion = currentVersion + 1;
        if (nextVersion <= currentVersion) {
            await client.runQuery("rollback");
            throw new errors_1.AppError("version_conflict", "Invalid document version.", 409);
        }
        const version = await (0, applications_repo_1.createDocumentVersion)({
            documentId,
            version: nextVersion,
            blobName: uploaded.blobName,
            hash: uploaded.hash,
            metadata: {
                ...params.metadata,
                mimeType: detectedType.mime,
                storageKey: uploaded.blobName,
                storageUrl: uploaded.url,
                hash: uploaded.hash,
            },
            content: "",
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_uploaded",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await (0, applications_repo_1.updateDocumentUploadDetails)({
            documentId,
            status: "uploaded",
            filename: params.metadata.fileName,
            storageKey: uploaded.blobName,
            uploadedBy: resolveUploadedBy(params.actorRole),
            client,
        });
        await (0, applications_repo_1.upsertApplicationRequiredDocument)({
            applicationId: params.applicationId,
            documentCategory: normalizedCategory,
            isRequired: requirement?.required === true,
            status: "uploaded",
            client,
        });
        const response = {
            documentId,
            versionId: version.id,
            version: version.version,
        };
        await client.runQuery("commit");
        if (isNewDocument) {
            if (normalizedCategory === BANK_STATEMENT_CATEGORY) {
                await (0, processing_service_1.createBankingAnalysisJob)(params.applicationId);
            }
            else {
                await (0, processing_service_1.createDocumentProcessingJob)(params.applicationId, documentId);
            }
        }
        return { status: 201, value: response, idempotent: false };
    }
    catch (err) {
        (0, transactionTelemetry_1.recordTransactionRollback)(err);
        try {
            await client.runQuery("rollback");
        }
        catch {
            // ignore rollback
        }
        throw err;
    }
    finally {
        client.release();
    }
}
async function changePipelineState(params) {
    const requestedState = params.nextState.trim().toUpperCase();
    const isDeclinedAlias = requestedState === "DECLINED";
    if (!isDeclinedAlias && !(0, pipelineState_1.isPipelineState)(requestedState)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
        throw new errors_1.AppError("forbidden", "Not authorized.", 403);
    }
    const currentStage = (0, applicationLifecycle_service_1.assertPipelineState)(application.pipeline_state);
    const nextStage = isDeclinedAlias ? "DECLINED" : requestedState;
    if (!params.override &&
        (currentStage === pipelineState_1.ApplicationStage.RECEIVED ||
            currentStage === pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) &&
        nextStage === pipelineState_1.ApplicationStage.OFF_TO_LENDER) {
        throw new errors_1.AppError("invalid_transition", "Invalid pipeline transition.", 400);
    }
    if (currentStage === nextStage) {
        return;
    }
    await (0, applications_repo_1.updateApplicationPipelineState)({
        applicationId: params.applicationId,
        pipelineState: nextStage,
    });
    await (0, applications_repo_1.createApplicationStageEvent)({
        applicationId: params.applicationId,
        fromStage: currentStage,
        toStage: nextStage,
        trigger: params.override ? "manual_override" : "manual_change",
        triggeredBy: params.actorUserId,
        reason: params.override ? "override" : null,
    });
    await (0, audit_service_1.recordAuditEvent)({
        action: "pipeline_state_changed",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: { from: currentStage, to: nextStage, override: params.override === true },
    });
}
async function acceptDocumentVersion(params) {
    assertStaffReviewRole(params.actorRole);
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, client);
        if (!application) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
        if (application.pipeline_state !== pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED &&
            application.pipeline_state !== pipelineState_1.ApplicationStage.RECEIVED) {
            throw new errors_1.AppError("invalid_state", "Documents can only be reviewed while in DOCUMENTS_REQUIRED.", 400);
        }
        const document = await (0, applications_repo_1.findDocumentById)(params.documentId, client);
        if (!document || document.application_id !== params.applicationId) {
            throw new errors_1.AppError("not_found", "Document not found.", 404);
        }
        await client.runQuery("select id from document_versions where id = $1 for update", [
            params.documentVersionId,
        ]);
        const version = await (0, applications_repo_1.findDocumentVersionById)(params.documentVersionId, client);
        if (!version || version.document_id !== params.documentId) {
            throw new errors_1.AppError("not_found", "Document version not found.", 404);
        }
        const review = await (0, applications_repo_1.findDocumentVersionReview)(params.documentVersionId, client);
        if (review) {
            throw new errors_1.AppError("version_reviewed", "Document version already reviewed.", 409);
        }
        try {
            await (0, applications_repo_1.createDocumentVersionReview)({
                documentVersionId: params.documentVersionId,
                status: "accepted",
                reviewedByUserId: params.actorUserId,
                client,
            });
        }
        catch (error) {
            if (error.code === "23505") {
                throw new errors_1.AppError("version_reviewed", "Document version already reviewed.", 409);
            }
            throw error;
        }
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_accepted",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        const requirement = await resolveRequirementForDocument({
            application,
            documentType: document.document_type,
            client,
        });
        await (0, applications_repo_1.updateDocumentStatus)({
            documentId: params.documentId,
            status: "accepted",
            rejectionReason: null,
            client,
        });
        await (0, applications_repo_1.upsertApplicationRequiredDocument)({
            applicationId: params.applicationId,
            documentCategory: requirement.documentCategory,
            isRequired: requirement.isRequired,
            status: "accepted",
            client,
        });
        const requiredDocuments = await (0, applications_repo_1.listApplicationRequiredDocuments)({
            applicationId: params.applicationId,
            client,
        });
        const hasPendingDocuments = requiredDocuments.some((doc) => doc.status !== "accepted");
        if (!hasPendingDocuments && application.pipeline_state === pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) {
            await (0, applications_repo_1.updateApplicationPipelineState)({
                applicationId: params.applicationId,
                pipelineState: pipelineState_1.ApplicationStage.IN_REVIEW,
                client,
            });
            await (0, applications_repo_1.createApplicationStageEvent)({
                applicationId: params.applicationId,
                fromStage: pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED,
                toStage: pipelineState_1.ApplicationStage.IN_REVIEW,
                trigger: "requirements_satisfied",
                triggeredBy: params.actorUserId,
                client,
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "pipeline_state_changed",
                actorUserId: params.actorUserId,
                targetUserId: application.owner_user_id,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                client,
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "pipeline_stage_changed",
                actorUserId: params.actorUserId,
                targetUserId: application.owner_user_id,
                targetType: "application",
                targetId: params.applicationId,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                metadata: {
                    from: pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED,
                    to: pipelineState_1.ApplicationStage.IN_REVIEW,
                },
                client,
            });
        }
        await (0, processingStage_service_1.advanceProcessingStage)({
            applicationId: params.applicationId,
            client,
        });
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function rejectDocumentVersion(params) {
    assertStaffReviewRole(params.actorRole);
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, client);
        if (!application) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
        if (application.pipeline_state !== pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED &&
            application.pipeline_state !== pipelineState_1.ApplicationStage.RECEIVED) {
            throw new errors_1.AppError("invalid_state", "Documents can only be reviewed while in DOCUMENTS_REQUIRED.", 400);
        }
        const document = await (0, applications_repo_1.findDocumentById)(params.documentId, client);
        if (!document || document.application_id !== params.applicationId) {
            throw new errors_1.AppError("not_found", "Document not found.", 404);
        }
        const requirement = await resolveRequirementForDocument({
            application,
            documentType: document.document_type,
            client,
        });
        await client.runQuery("select id from document_versions where id = $1 for update", [
            params.documentVersionId,
        ]);
        const version = await (0, applications_repo_1.findDocumentVersionById)(params.documentVersionId, client);
        if (!version || version.document_id !== params.documentId) {
            throw new errors_1.AppError("not_found", "Document version not found.", 404);
        }
        const review = await (0, applications_repo_1.findDocumentVersionReview)(params.documentVersionId, client);
        if (review) {
            throw new errors_1.AppError("version_reviewed", "Document version already reviewed.", 409);
        }
        try {
            await (0, applications_repo_1.createDocumentVersionReview)({
                documentVersionId: params.documentVersionId,
                status: "rejected",
                reviewedByUserId: params.actorUserId,
                client,
            });
        }
        catch (error) {
            if (error.code === "23505") {
                throw new errors_1.AppError("version_reviewed", "Document version already reviewed.", 409);
            }
            throw error;
        }
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_rejected",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await (0, applications_repo_1.updateDocumentStatus)({
            documentId: params.documentId,
            status: "rejected",
            rejectionReason: null,
            client,
        });
        await (0, applications_repo_1.upsertApplicationRequiredDocument)({
            applicationId: params.applicationId,
            documentCategory: requirement.documentCategory,
            isRequired: requirement.isRequired,
            status: "rejected",
            client,
        });
        await enforceDocumentsRequiredStage({
            application,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            trigger: "document_rejected",
            client,
        });
        await (0, processingStage_service_1.advanceProcessingStage)({
            applicationId: params.applicationId,
            client,
        });
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function acceptDocument(params) {
    assertStaffReviewRole(params.actorRole);
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const document = await (0, applications_repo_1.findDocumentById)(params.documentId, client);
        if (!document) {
            throw new errors_1.AppError("not_found", "Document not found.", 404);
        }
        const application = await (0, applications_repo_1.findApplicationById)(document.application_id, client);
        if (!application) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        const requirement = await resolveRequirementForDocument({
            application,
            documentType: document.document_type,
            client,
        });
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
        const version = await (0, applications_repo_1.findActiveDocumentVersion)({ documentId: params.documentId, client });
        if (!version) {
            throw new errors_1.AppError("not_found", "Document version not found.", 404);
        }
        const review = await (0, applications_repo_1.findDocumentVersionReview)(version.id, client);
        if (review) {
            throw new errors_1.AppError("version_reviewed", "Document version already reviewed.", 409);
        }
        await (0, applications_repo_1.createDocumentVersionReview)({
            documentVersionId: version.id,
            status: "accepted",
            reviewedByUserId: params.actorUserId,
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_accepted",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await (0, applications_repo_1.updateDocumentStatus)({
            documentId: params.documentId,
            status: "accepted",
            rejectionReason: null,
            client,
        });
        await (0, applications_repo_1.upsertApplicationRequiredDocument)({
            applicationId: application.id,
            documentCategory: requirement.documentCategory,
            isRequired: requirement.isRequired,
            status: "accepted",
            client,
        });
        await (0, processingStage_service_1.advanceProcessingStage)({
            applicationId: application.id,
            client,
        });
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function rejectDocument(params) {
    assertStaffReviewRole(params.actorRole);
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const document = await (0, applications_repo_1.findDocumentById)(params.documentId, client);
        if (!document) {
            throw new errors_1.AppError("not_found", "Document not found.", 404);
        }
        const application = await (0, applications_repo_1.findApplicationById)(document.application_id, client);
        if (!application) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        const requirement = await resolveRequirementForDocument({
            application,
            documentType: document.document_type,
            client,
        });
        if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
            throw new errors_1.AppError("forbidden", "Not authorized.", 403);
        }
        const version = await (0, applications_repo_1.findActiveDocumentVersion)({ documentId: params.documentId, client });
        if (!version) {
            throw new errors_1.AppError("not_found", "Document version not found.", 404);
        }
        const review = await (0, applications_repo_1.findDocumentVersionReview)(version.id, client);
        if (review) {
            throw new errors_1.AppError("version_reviewed", "Document version already reviewed.", 409);
        }
        await (0, applications_repo_1.createDocumentVersionReview)({
            documentVersionId: version.id,
            status: "rejected",
            reviewedByUserId: params.actorUserId,
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "document_rejected",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await (0, applications_repo_1.updateDocumentStatus)({
            documentId: params.documentId,
            status: "rejected",
            rejectionReason: params.rejectionReason,
            client,
        });
        await (0, applications_repo_1.upsertApplicationRequiredDocument)({
            applicationId: application.id,
            documentCategory: requirement.documentCategory,
            isRequired: requirement.isRequired,
            status: "rejected",
            client,
        });
        await enforceDocumentsRequiredStage({
            application,
            actorUserId: params.actorUserId,
            actorRole: params.actorRole,
            trigger: "document_rejected",
            client,
        });
        await (0, processingStage_service_1.advanceProcessingStage)({
            applicationId: application.id,
            client,
        });
        await client.runQuery("commit");
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
function fetchPipelineStates() {
    return [...pipelineState_1.PIPELINE_STATES];
}
