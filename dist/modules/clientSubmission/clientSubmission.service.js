"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitClientApplication = submitClientApplication;
const errors_1 = require("../../middleware/errors");
const db_1 = require("../../db");
const applications_repo_1 = require("../applications/applications.repo");
const pipelineState_1 = require("../applications/pipelineState");
const audit_service_1 = require("../audit/audit.service");
const config_1 = require("../../config");
const clientSubmission_repo_1 = require("./clientSubmission.repo");
const logger_1 = require("../../observability/logger");
const transactionTelemetry_1 = require("../../observability/transactionTelemetry");
const lenderProductRequirementsService_1 = require("../../services/lenderProductRequirementsService");
const v1StructuredPersistence_1 = require("../../services/v1StructuredPersistence");
const requiredDocuments_1 = require("../../db/schema/requiredDocuments");
function assertObject(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new errors_1.AppError("invalid_payload", `${label} is required.`, 400);
    }
}
function assertExactKeys(record, keys, label) {
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        throw new errors_1.AppError("invalid_payload", `${label} has invalid fields.`, 400);
    }
}
function assertAllowedKeys(record, allowedKeys, label) {
    const allowed = new Set(allowedKeys);
    const invalid = Object.keys(record).filter((key) => !allowed.has(key));
    if (invalid.length > 0) {
        throw new errors_1.AppError("invalid_payload", `${label} has invalid fields.`, 400);
    }
}
function assertString(value, label) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new errors_1.AppError("invalid_payload", `${label} is required.`, 400);
    }
    return value;
}
function assertDocuments(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new errors_1.AppError("invalid_payload", "documents are required.", 400);
    }
    return value.map((entry, index) => {
        assertObject(entry, `documents[${index}]`);
        assertExactKeys(entry, ["title", "documentType", "metadata", "content"], `documents[${index}]`);
        const title = assertString(entry.title, `documents[${index}].title`);
        const documentType = assertString(entry.documentType, `documents[${index}].documentType`);
        const content = assertString(entry.content, `documents[${index}].content`);
        assertObject(entry.metadata, `documents[${index}].metadata`);
        assertExactKeys(entry.metadata, ["fileName", "mimeType", "size"], `documents[${index}].metadata`);
        const fileName = assertString(entry.metadata.fileName, `documents[${index}].metadata.fileName`);
        const mimeType = assertString(entry.metadata.mimeType, `documents[${index}].metadata.mimeType`);
        const sizeValue = entry.metadata.size;
        if (typeof sizeValue !== "number" || Number.isNaN(sizeValue) || sizeValue <= 0) {
            throw new errors_1.AppError("invalid_payload", `documents[${index}].metadata.size is invalid.`, 400);
        }
        return {
            title,
            documentType,
            content,
            metadata: {
                fileName,
                mimeType,
                size: sizeValue,
            },
        };
    });
}
function assertPayload(payload) {
    assertObject(payload, "payload");
    assertAllowedKeys(payload, [
        "submissionKey",
        "productType",
        "business",
        "applicant",
        "documents",
        "selected_lender_product_id",
        "selectedLenderProductId",
    ], "payload");
    const submissionKey = assertString(payload.submissionKey, "submissionKey");
    const productType = assertString(payload.productType, "productType");
    const rawSelected = payload.selected_lender_product_id ?? payload.selectedLenderProductId;
    if (payload.selected_lender_product_id !== undefined &&
        payload.selectedLenderProductId !== undefined &&
        payload.selected_lender_product_id !== payload.selectedLenderProductId) {
        throw new errors_1.AppError("invalid_payload", "selectedLenderProductId does not match selected_lender_product_id.", 400);
    }
    const selectedLenderProductId = rawSelected === undefined || rawSelected === null
        ? null
        : assertString(rawSelected, "selectedLenderProductId");
    assertObject(payload.business, "business");
    assertExactKeys(payload.business, ["legalName", "taxId", "entityType", "address"], "business");
    const legalName = assertString(payload.business.legalName, "business.legalName");
    const taxId = assertString(payload.business.taxId, "business.taxId");
    const entityType = assertString(payload.business.entityType, "business.entityType");
    assertObject(payload.business.address, "business.address");
    assertExactKeys(payload.business.address, ["line1", "city", "state", "postalCode", "country"], "business.address");
    const address = {
        line1: assertString(payload.business.address.line1, "business.address.line1"),
        city: assertString(payload.business.address.city, "business.address.city"),
        state: assertString(payload.business.address.state, "business.address.state"),
        postalCode: assertString(payload.business.address.postalCode, "business.address.postalCode"),
        country: assertString(payload.business.address.country, "business.address.country"),
    };
    assertObject(payload.applicant, "applicant");
    assertExactKeys(payload.applicant, ["firstName", "lastName", "email", "phone"], "applicant");
    const applicant = {
        firstName: assertString(payload.applicant.firstName, "applicant.firstName"),
        lastName: assertString(payload.applicant.lastName, "applicant.lastName"),
        email: assertString(payload.applicant.email, "applicant.email"),
        phone: assertString(payload.applicant.phone, "applicant.phone"),
    };
    const documents = assertDocuments(payload.documents);
    return {
        submissionKey,
        productType,
        selectedLenderProductId,
        business: {
            legalName,
            taxId,
            entityType,
            address,
        },
        applicant,
        documents,
    };
}
function enforceDocumentRules(requirements, documents) {
    const allowedTypes = new Set(requirements
        .map((req) => (0, requiredDocuments_1.normalizeRequiredDocumentKey)(req.documentType))
        .filter((key) => Boolean(key)));
    const counts = new Map();
    documents.forEach((doc) => {
        const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(doc.documentType);
        if (!normalized || !allowedTypes.has(normalized)) {
            throw new errors_1.AppError("invalid_document_type", "Document type is not allowed.", 400);
        }
        counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    });
    for (const requirement of requirements) {
        const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(requirement.documentType);
        const count = normalized ? counts.get(normalized) ?? 0 : 0;
        if (requirement.required && count === 0) {
            throw new errors_1.AppError("missing_documents", "Required documents are missing.", 400);
        }
    }
}
function enforceDocumentMetadata(documents) {
    const allowed = config_1.config.documents.allowedMimeTypes;
    const maxSize = config_1.config.documents.maxSizeBytes;
    for (const doc of documents) {
        if (!allowed.includes(doc.metadata.mimeType)) {
            throw new errors_1.AppError("invalid_mime_type", "Unsupported document MIME type.", 400);
        }
        if (doc.metadata.size > maxSize) {
            throw new errors_1.AppError("document_too_large", "Document exceeds max size.", 400);
        }
    }
}
async function submitClientApplication(params) {
    const submission = assertPayload(params.payload);
    const { requirements, lenderProductId } = await (0, lenderProductRequirementsService_1.resolveRequirementsForApplication)({
        lenderProductId: submission.selectedLenderProductId ?? null,
        productType: submission.productType,
        country: submission.business.address.country,
    });
    enforceDocumentRules(requirements, submission.documents);
    enforceDocumentMetadata(submission.documents);
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        const existing = await (0, clientSubmission_repo_1.findClientSubmissionByKey)(submission.submissionKey, client);
        if (existing) {
            await (0, audit_service_1.recordAuditEvent)({
                action: "client_submission_retried",
                actorUserId: null,
                targetUserId: null,
                targetType: "application",
                targetId: existing.application_id,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                client,
            });
            await client.query("commit");
            (0, logger_1.logInfo)("client_submission_retried", {
                submissionKey: submission.submissionKey,
                applicationId: existing.application_id,
            });
            return {
                status: 200,
                value: {
                    applicationId: existing.application_id,
                    pipelineState: pipelineState_1.ApplicationStage.RECEIVED,
                },
                idempotent: true,
            };
        }
        const ownerUserId = config_1.config.client.submissionOwnerUserId;
        const application = await (0, applications_repo_1.createApplication)({
            ownerUserId,
            name: submission.business.legalName,
            metadata: {
                submissionKey: submission.submissionKey,
                business: submission.business,
                applicant: submission.applicant,
                requirementsSnapshot: requirements.map((req) => ({
                    documentType: req.documentType,
                    required: req.required,
                    minAmount: req.minAmount ?? null,
                    maxAmount: req.maxAmount ?? null,
                })),
            },
            productType: submission.productType,
            productCategory: submission.productType,
            lenderProductId,
            trigger: "client_submission_created",
            triggeredBy: "system",
            client,
        });
        await (0, v1StructuredPersistence_1.upsertStructuredApplicationData)({
            applicationId: application.id,
            companyName: submission.business.legalName,
            entityType: submission.business.entityType,
            country: submission.business.address.country,
            provinceState: submission.business.address.state,
            owners: [
                {
                    name: `${submission.applicant.firstName} ${submission.applicant.lastName}`.trim(),
                    email: submission.applicant.email,
                    phone: submission.applicant.phone,
                },
            ],
        }, client);
        for (const doc of submission.documents) {
            const document = await (0, applications_repo_1.createDocument)({
                applicationId: application.id,
                ownerUserId,
                title: doc.title,
                documentType: doc.documentType,
                client,
            });
            await (0, applications_repo_1.createDocumentVersion)({
                documentId: document.id,
                version: 1,
                metadata: doc.metadata,
                content: doc.content,
                client,
            });
            await (0, audit_service_1.recordAuditEvent)({
                action: "document_uploaded",
                actorUserId: null,
                targetUserId: ownerUserId,
                targetType: "document",
                targetId: document.id,
                ip: params.ip ?? null,
                userAgent: params.userAgent ?? null,
                success: true,
                client,
            });
        }
        await (0, clientSubmission_repo_1.createClientSubmission)({
            submissionKey: submission.submissionKey,
            applicationId: application.id,
            payload: submission,
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "client_submission_created",
            actorUserId: null,
            targetUserId: ownerUserId,
            targetType: "application",
            targetId: application.id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            client,
        });
        await client.query("commit");
        (0, logger_1.logInfo)("client_submission_created", {
            submissionKey: submission.submissionKey,
            applicationId: application.id,
        });
        return {
            status: 201,
            value: { applicationId: application.id, pipelineState: application.pipeline_state },
            idempotent: false,
        };
    }
    catch (err) {
        (0, transactionTelemetry_1.recordTransactionRollback)(err);
        await client.query("rollback");
        await (0, audit_service_1.recordAuditEvent)({
            action: "client_submission_failed",
            actorUserId: null,
            targetUserId: null,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: false,
        });
        (0, logger_1.logWarn)("client_submission_failed", {
            submissionKey: typeof params.payload === "object" && params.payload !== null
                ? params.payload.submissionKey
                : undefined,
            error: err instanceof Error ? err.message : "unknown_error",
        });
        throw err;
    }
    finally {
        client.release();
    }
}
