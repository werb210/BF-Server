"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitApplication = submitApplication;
exports.fetchSubmissionStatus = fetchSubmissionStatus;
exports.fetchTransmissionStatus = fetchTransmissionStatus;
exports.retrySubmission = retrySubmission;
exports.cancelSubmissionRetry = cancelSubmissionRetry;
const errors_1 = require("../../middleware/errors");
const crypto_1 = require("crypto");
const audit_service_1 = require("../audit/audit.service");
const db_1 = require("../../db");
const applications_repo_1 = require("../applications/applications.repo");
const pipelineState_1 = require("../applications/pipelineState");
const applications_service_1 = require("../applications/applications.service");
const lenderProductRequirementsService_1 = require("../../services/lenderProductRequirementsService");
const requiredDocuments_1 = require("../../db/schema/requiredDocuments");
const lender_repo_1 = require("./lender.repo");
const config_1 = require("../../config");
const ops_service_1 = require("../ops/ops.service");
const logger_1 = require("../../observability/logger");
const transactionTelemetry_1 = require("../../observability/transactionTelemetry");
const dbRuntime_1 = require("../../dbRuntime");
const SubmissionRouter_1 = require("../submissions/SubmissionRouter");
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
function buildAuditContext(params) {
    return {
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
    };
}
function createAdvisoryLockKey(value) {
    const hash = (0, crypto_1.createHash)("sha256").update(value).digest();
    return [hash.readInt32BE(0), hash.readInt32BE(4)];
}
function hashPayload(payload) {
    const serialized = JSON.stringify(payload);
    return (0, crypto_1.createHash)("sha256").update(serialized).digest("hex");
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
async function assertLenderProduct(params) {
    const res = await params.client.query(`select lender_id
     from lender_products
     where id = $1
     limit 1`, [params.lenderProductId]);
    if (res.rows.length === 0) {
        throw new errors_1.AppError("invalid_product", "Lender product not found.", 400);
    }
    const row = res.rows[0];
    if (!row) {
        throw new errors_1.AppError("invalid_product", "Lender product not found.", 400);
    }
    if (row.lender_id !== params.lenderId) {
        throw new errors_1.AppError("invalid_product", "Lender product does not match lender.", 400);
    }
}
function mapToLenderPayload(lenderId, packet) {
    const basePayload = {
        application: packet.application,
        documents: packet.documents,
        submittedAt: packet.submittedAt,
    };
    if (lenderId === "fastfund") {
        return {
            ...basePayload,
            applicantName: `${packet.application.name}`,
            productType: packet.application.productType,
            lenderProductId: packet.application.lenderProductId,
            businessMetadata: packet.application.metadata,
            docs: packet.documents.map((doc) => ({
                type: doc.documentType,
                title: doc.title,
                version: doc.version,
                meta: doc.metadata,
                content: doc.content,
            })),
        };
    }
    if (lenderId === "timeout") {
        return {
            ...basePayload,
            payload: packet,
        };
    }
    return basePayload;
}
function buildAttachmentBundle(packet) {
    return packet.documents.map((doc) => ({
        documentId: doc.documentId,
        documentType: doc.documentType,
        title: doc.title,
        metadata: doc.metadata,
        content: doc.content,
    }));
}
async function sendToLender(params) {
    try {
        const router = new SubmissionRouter_1.SubmissionRouter({
            profile: params.profile,
            payload: params.payload,
            attempt: params.attempt,
        });
        return await router.submit();
    }
    catch (error) {
        (0, logger_1.logWarn)("lender_submission_adapter_error", {
            lenderId: params.profile.lenderId,
            lenderName: params.profile.lenderName,
            error,
        });
        return {
            success: false,
            response: {
                status: "adapter_error",
                detail: error instanceof Error ? error.message : "Submission adapter error.",
                receivedAt: new Date().toISOString(),
            },
            failureReason: "adapter_error",
            retryable: false,
        };
    }
}
async function resolveSubmissionMethod(params) {
    const res = await params.client.query(`select submission_method
     from lenders
     where id = $1
     limit 1`, [params.lenderId]);
    if (res.rows.length === 0) {
        throw new errors_1.AppError("not_found", "Lender not found.", 404);
    }
    const row = res.rows[0];
    if (!row) {
        throw new errors_1.AppError("not_found", "Lender not found.", 404);
    }
    return (0, SubmissionRouter_1.normalizeSubmissionMethod)(row.submission_method) ?? "email";
}
async function buildSubmissionPacket(params) {
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
    const requiredTypes = requirements
        .filter((req) => req.required)
        .map((req) => req.documentType);
    const requiredAliases = requiredTypes.flatMap((type) => {
        const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(type);
        return normalized ? (0, requiredDocuments_1.fetchDocumentTypeAliases)(normalized) : [type];
    });
    const documents = await (0, applications_repo_1.listLatestAcceptedDocumentVersions)({
        applicationId: application.id,
        documentTypes: requiredAliases,
        client: params.client,
    });
    const normalizedDocs = new Set(documents
        .map((doc) => (0, requiredDocuments_1.normalizeRequiredDocumentKey)(doc.document_type) ?? doc.document_type)
        .filter((docType) => docType));
    const missingDocumentTypes = requiredTypes.filter((docType) => {
        const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(docType) ?? docType;
        return !normalizedDocs.has(normalized);
    });
    return {
        packet: {
            application: {
                id: application.id,
                ownerUserId: application.owner_user_id,
                name: application.name,
                metadata: application.metadata,
                productType: application.product_type,
                lenderId: application.lender_id,
                lenderProductId: application.lender_product_id,
                requestedAmount: application.requested_amount ?? null,
            },
            documents: documents.map((doc) => ({
                documentId: doc.document_id,
                documentType: doc.document_type,
                title: doc.title,
                versionId: doc.version_id,
                version: doc.version,
                metadata: doc.metadata,
                content: doc.content,
            })),
            submittedAt: params.submittedAt.toISOString(),
        },
        missingDocumentTypes,
    };
}
function calculateNextAttempt(attemptCount) {
    const baseDelay = config_1.config.lender.retry.baseDelayMs;
    const maxDelay = config_1.config.lender.retry.maxDelayMs;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(2, Math.max(0, attemptCount - 1)));
    return new Date(Date.now() + delay);
}
async function recordSubmissionFailure(params) {
    await (0, lender_repo_1.updateSubmissionStatus)({
        submissionId: params.submissionId,
        status: "failed",
        lenderResponse: params.response,
        responseReceivedAt: new Date(params.response.receivedAt),
        failureReason: params.failureReason,
        externalReference: params.response.externalReference ?? null,
        client: params.client,
    });
    await (0, lender_repo_1.createSubmissionEvent)({
        applicationId: params.applicationId,
        lenderId: params.lenderId,
        method: params.method,
        status: "failed",
        internalError: params.response.detail ?? params.failureReason,
        timestamp: new Date(),
        client: params.client,
    });
    if (params.retryable) {
        const currentRetry = await (0, lender_repo_1.findSubmissionRetryState)(params.submissionId, params.client);
        const nextAttemptCount = (currentRetry?.attempt_count ?? 0) + 1;
        const nextAttemptAt = calculateNextAttempt(nextAttemptCount);
        await (0, lender_repo_1.upsertSubmissionRetryState)({
            submissionId: params.submissionId,
            status: "pending",
            attemptCount: nextAttemptCount,
            nextAttemptAt,
            lastError: params.failureReason,
            canceledAt: null,
            client: params.client,
        });
    }
    const nextState = params.retryable
        ? pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED
        : pipelineState_1.ApplicationStage.REJECTED;
    const current = await (0, applications_repo_1.findApplicationById)(params.applicationId, params.client);
    if (current && (0, pipelineState_1.isPipelineState)(current.pipeline_state) && current.pipeline_state !== nextState) {
        await (0, applications_service_1.transitionPipelineState)({
            applicationId: params.applicationId,
            nextState,
            actorUserId: params.actorUserId,
            actorRole: null,
            trigger: "submission_failed",
            ...buildRequestMetadata(params),
            client: params.client,
        });
    }
    await (0, audit_service_1.recordAuditEvent)({
        action: "lender_submission_failed",
        actorUserId: params.actorUserId,
        targetUserId: params.ownerUserId,
        targetType: "application",
        targetId: params.applicationId,
        ...buildAuditContext(params),
        success: false,
        client: params.client,
    });
}
async function transmitSubmission(params) {
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, params.client);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!(0, pipelineState_1.isPipelineState)(application.pipeline_state)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    if (!application.lender_id) {
        throw new errors_1.AppError("missing_lender", "Application lender is not set.", 400);
    }
    if (application.lender_id !== params.lenderId) {
        throw new errors_1.AppError("invalid_lender", "Application lender does not match request.", 400);
    }
    if (!application.lender_product_id) {
        throw new errors_1.AppError("missing_product", "Application lender product is not set.", 400);
    }
    if (application.lender_product_id !== params.lenderProductId) {
        throw new errors_1.AppError("invalid_product", "Application lender product does not match request.", 400);
    }
    if (application.pipeline_state !== pipelineState_1.ApplicationStage.IN_REVIEW &&
        application.pipeline_state !== pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) {
        throw new errors_1.AppError("invalid_state", "Application must be in IN_REVIEW or DOCUMENTS_REQUIRED to submit to lenders.", 400);
    }
    const submissionMethod = await resolveSubmissionMethod({
        lenderId: params.lenderId,
        client: params.client,
    });
    const submittedAt = new Date();
    const { packet, missingDocumentTypes } = await buildSubmissionPacket({
        applicationId: params.applicationId,
        submittedAt,
        client: params.client,
    });
    if (!params.skipRequiredDocuments && missingDocumentTypes.length > 0) {
        const submission = await (0, lender_repo_1.createSubmission)({
            applicationId: params.applicationId,
            idempotencyKey: params.idempotencyKey,
            status: "pending",
            lenderId: params.lenderId,
            submissionMethod,
            submittedAt,
            payload: packet,
            payloadHash: hashPayload(packet),
            lenderResponse: null,
            responseReceivedAt: null,
            failureReason: null,
            externalReference: null,
            client: params.client,
        });
        await (0, lender_repo_1.createSubmissionEvent)({
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            method: submissionMethod,
            status: "pending",
            internalError: null,
            timestamp: new Date(),
            client: params.client,
        });
        await recordSubmissionFailure({
            submissionId: submission.id,
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            ownerUserId: application.owner_user_id,
            failureReason: "missing_documents",
            response: {
                status: "missing_documents",
                detail: `Missing: ${missingDocumentTypes.join(", ")}`,
                receivedAt: new Date().toISOString(),
            },
            retryable: true,
            method: submissionMethod,
            actorUserId: params.actorUserId,
            ...buildRequestMetadata(params),
            client: params.client,
        });
        (0, logger_1.logWarn)("lender_submission_failed", {
            submissionId: submission.id,
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            reason: "missing_documents",
        });
        return {
            statusCode: 400,
            value: { id: submission.id, status: "failed", failureReason: "missing_documents" },
            idempotent: false,
        };
    }
    let payload;
    try {
        payload = mapToLenderPayload(params.lenderId, packet);
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "lender_submission_failed",
            actorUserId: params.actorUserId,
            targetUserId: application.owner_user_id,
            targetType: "application",
            targetId: params.applicationId,
            ...buildAuditContext(params),
            success: false,
            client: params.client,
        });
        throw err;
    }
    if (submissionMethod === "email") {
        payload = {
            ...payload,
            attachmentBundle: buildAttachmentBundle(packet),
        };
    }
    const payloadHash = hashPayload(payload);
    const submission = await (0, lender_repo_1.createSubmission)({
        applicationId: params.applicationId,
        idempotencyKey: params.idempotencyKey,
        status: "pending",
        lenderId: params.lenderId,
        submissionMethod,
        submittedAt,
        payload,
        payloadHash,
        lenderResponse: null,
        responseReceivedAt: null,
        failureReason: null,
        externalReference: null,
        client: params.client,
    });
    (0, logger_1.logInfo)("lender_submission_created", {
        submissionId: submission.id,
        applicationId: params.applicationId,
        lenderId: params.lenderId,
    });
    await (0, lender_repo_1.createSubmissionEvent)({
        applicationId: params.applicationId,
        lenderId: params.lenderId,
        method: submissionMethod,
        status: "pending",
        internalError: null,
        timestamp: new Date(),
        client: params.client,
    });
    const profile = await (0, SubmissionRouter_1.resolveSubmissionProfile)(params.lenderId, params.client);
    const response = await sendToLender({
        profile,
        payload,
        attempt: params.attempt,
    });
    if (!response.success) {
        await recordSubmissionFailure({
            submissionId: submission.id,
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            ownerUserId: application.owner_user_id,
            failureReason: response.failureReason ?? "lender_error",
            response: response.response,
            retryable: response.retryable,
            method: submissionMethod,
            actorUserId: params.actorUserId,
            ...buildRequestMetadata(params),
            client: params.client,
        });
        (0, logger_1.logWarn)("lender_submission_failed", {
            submissionId: submission.id,
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            reason: response.failureReason ?? "lender_error",
        });
        return {
            statusCode: 502,
            value: { id: submission.id, status: "failed", failureReason: "submission_failed" },
            idempotent: false,
        };
    }
    await (0, lender_repo_1.updateSubmissionStatus)({
        submissionId: submission.id,
        status: "submitted",
        lenderResponse: response.response,
        responseReceivedAt: new Date(response.response.receivedAt),
        failureReason: null,
        externalReference: response.response.externalReference ?? null,
        client: params.client,
    });
    (0, logger_1.logInfo)("lender_submission_submitted", {
        submissionId: submission.id,
        applicationId: params.applicationId,
        lenderId: params.lenderId,
    });
    await (0, lender_repo_1.createSubmissionEvent)({
        applicationId: params.applicationId,
        lenderId: params.lenderId,
        method: submissionMethod,
        status: "submitted",
        internalError: null,
        timestamp: new Date(),
        client: params.client,
    });
    if (application.pipeline_state === pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) {
        await (0, applications_service_1.transitionPipelineState)({
            applicationId: params.applicationId,
            nextState: pipelineState_1.ApplicationStage.IN_REVIEW,
            actorUserId: params.actorUserId,
            actorRole: null,
            trigger: "submission_review_started",
            ...buildRequestMetadata(params),
            client: params.client,
        });
    }
    if (application.pipeline_state === pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED ||
        application.pipeline_state === pipelineState_1.ApplicationStage.IN_REVIEW) {
        await (0, applications_service_1.transitionPipelineState)({
            applicationId: params.applicationId,
            nextState: pipelineState_1.ApplicationStage.STARTUP,
            actorUserId: params.actorUserId,
            actorRole: null,
            trigger: "submission_prepared",
            ...buildRequestMetadata(params),
            client: params.client,
        });
    }
    await (0, applications_service_1.transitionPipelineState)({
        applicationId: params.applicationId,
        nextState: pipelineState_1.ApplicationStage.OFF_TO_LENDER,
        actorUserId: params.actorUserId,
        actorRole: null,
        trigger: "submission_sent",
        ...buildRequestMetadata(params),
        client: params.client,
    });
    await (0, applications_repo_1.updateApplicationStatus)({
        applicationId: params.applicationId,
        status: "SUBMITTED_TO_LENDER",
        client: params.client,
    });
    await (0, audit_service_1.recordAuditEvent)({
        action: "lender_submission_created",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        targetType: "application",
        targetId: params.applicationId,
        ...buildAuditContext(params),
        success: true,
        client: params.client,
    });
    return {
        statusCode: 201,
        value: { id: submission.id, status: "submitted" },
        idempotent: false,
    };
}
async function retryExistingSubmission(params) {
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, params.client);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    const response = await sendToLender({
        profile: params.profile,
        payload: params.payload,
        attempt: params.attempt,
    });
    if (!response.success) {
        await recordSubmissionFailure({
            submissionId: params.submissionId,
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            ownerUserId: application.owner_user_id,
            failureReason: response.failureReason ?? "lender_error",
            response: response.response,
            retryable: response.retryable,
            method: params.submissionMethod,
            actorUserId: params.actorUserId,
            ...buildRequestMetadata(params),
            client: params.client,
        });
        return {
            statusCode: 502,
            value: { id: params.submissionId, status: "failed", failureReason: "submission_failed" },
            idempotent: false,
        };
    }
    await (0, lender_repo_1.updateSubmissionStatus)({
        submissionId: params.submissionId,
        status: "submitted",
        lenderResponse: response.response,
        responseReceivedAt: new Date(response.response.receivedAt),
        failureReason: null,
        externalReference: response.response.externalReference ?? null,
        client: params.client,
    });
    await (0, lender_repo_1.createSubmissionEvent)({
        applicationId: params.applicationId,
        lenderId: params.lenderId,
        method: params.submissionMethod,
        status: "submitted",
        internalError: null,
        timestamp: new Date(),
        client: params.client,
    });
    if (application.pipeline_state === pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED) {
        await (0, applications_service_1.transitionPipelineState)({
            applicationId: params.applicationId,
            nextState: pipelineState_1.ApplicationStage.IN_REVIEW,
            actorUserId: params.actorUserId,
            actorRole: null,
            trigger: "submission_review_started",
            ...buildRequestMetadata(params),
            client: params.client,
        });
    }
    if (application.pipeline_state === pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED ||
        application.pipeline_state === pipelineState_1.ApplicationStage.IN_REVIEW) {
        await (0, applications_service_1.transitionPipelineState)({
            applicationId: params.applicationId,
            nextState: pipelineState_1.ApplicationStage.STARTUP,
            actorUserId: params.actorUserId,
            actorRole: null,
            trigger: "submission_prepared",
            ...buildRequestMetadata(params),
            client: params.client,
        });
    }
    await (0, applications_service_1.transitionPipelineState)({
        applicationId: params.applicationId,
        nextState: pipelineState_1.ApplicationStage.OFF_TO_LENDER,
        actorUserId: params.actorUserId,
        actorRole: null,
        trigger: "submission_sent",
        ...buildRequestMetadata(params),
        client: params.client,
    });
    await (0, applications_repo_1.updateApplicationStatus)({
        applicationId: params.applicationId,
        status: "SUBMITTED_TO_LENDER",
        client: params.client,
    });
    return {
        statusCode: 200,
        value: { id: params.submissionId, status: "submitted" },
        idempotent: false,
    };
}
async function submitApplication(params) {
    if (await (0, ops_service_1.isKillSwitchEnabled)("lender_transmission")) {
        throw new errors_1.AppError("ops_kill_switch", "Lender transmissions are currently disabled.", 423);
    }
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        const lockKey = createAdvisoryLockKey(`transmission:${params.applicationId}:${params.lenderId}`);
        if (!(0, dbRuntime_1.isTestEnvironment)()) {
            await client.query("select pg_advisory_xact_lock($1, $2)", lockKey);
        }
        await client.query("select id from applications where id = $1 for update", [
            params.applicationId,
        ]);
        if (params.idempotencyKey) {
            const existingSubmission = await (0, lender_repo_1.findSubmissionByIdempotencyKey)(params.idempotencyKey, client);
            if (existingSubmission) {
                await (0, audit_service_1.recordAuditEvent)({
                    action: "lender_submission_retried",
                    actorUserId: params.actorUserId,
                    targetUserId: null,
                    targetType: "application",
                    targetId: existingSubmission.application_id,
                    ...buildAuditContext(params),
                    success: true,
                    client,
                });
                await client.query("commit");
                return {
                    statusCode: 200,
                    value: { id: existingSubmission.id, status: existingSubmission.status },
                    idempotent: true,
                };
            }
        }
        const existingSubmission = await (0, lender_repo_1.findSubmissionByApplicationAndLender)({ applicationId: params.applicationId, lenderId: params.lenderId }, client);
        if (existingSubmission) {
            await (0, audit_service_1.recordAuditEvent)({
                action: "lender_submission_retried",
                actorUserId: params.actorUserId,
                targetUserId: null,
                targetType: "application",
                targetId: params.applicationId,
                ...buildAuditContext(params),
                success: true,
                client,
            });
            await client.query("commit");
            return {
                statusCode: 200,
                value: { id: existingSubmission.id, status: existingSubmission.status },
                idempotent: true,
            };
        }
        await assertLenderProduct({
            lenderId: params.lenderId,
            lenderProductId: params.lenderProductId,
            client,
        });
        const result = await transmitSubmission({
            applicationId: params.applicationId,
            lenderId: params.lenderId,
            lenderProductId: params.lenderProductId,
            idempotencyKey: params.idempotencyKey,
            actorUserId: params.actorUserId,
            ...buildRequestMetadata(params),
            attempt: 0,
            ...(params.skipRequiredDocuments !== undefined
                ? { skipRequiredDocuments: params.skipRequiredDocuments }
                : {}),
            client,
        });
        await client.query("commit");
        return result;
    }
    catch (err) {
        (0, transactionTelemetry_1.recordTransactionRollback)(err);
        await client.query("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function fetchSubmissionStatus(id) {
    const submission = await (0, lender_repo_1.findSubmissionById)(id);
    if (!submission) {
        throw new errors_1.AppError("not_found", "Submission not found.", 404);
    }
    return {
        id: submission.id,
        status: submission.status,
        applicationId: submission.application_id,
        lenderResponse: submission.lender_response ?? null,
    };
}
async function fetchTransmissionStatus(applicationId) {
    const submission = await (0, lender_repo_1.findLatestSubmissionByApplicationId)(applicationId);
    if (!submission) {
        throw new errors_1.AppError("not_found", "Submission not found.", 404);
    }
    const retry = await (0, lender_repo_1.findSubmissionRetryState)(submission.id);
    return {
        applicationId,
        submissionId: submission.id,
        status: submission.status,
        lenderId: submission.lender_id,
        submittedAt: submission.submitted_at ? submission.submitted_at.toISOString() : null,
        payloadHash: submission.payload_hash,
        lastResponse: submission.lender_response ?? null,
        retryState: {
            status: retry?.status ?? null,
            attemptCount: retry?.attempt_count ?? null,
            nextAttemptAt: retry?.next_attempt_at ? retry.next_attempt_at.toISOString() : null,
            lastError: retry?.last_error ?? null,
        },
    };
}
async function retrySubmission(params) {
    if (await (0, ops_service_1.isKillSwitchEnabled)("lender_transmission")) {
        throw new errors_1.AppError("ops_kill_switch", "Lender transmissions are currently disabled.", 423);
    }
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        const submission = await (0, lender_repo_1.findSubmissionById)(params.submissionId, client);
        if (!submission) {
            throw new errors_1.AppError("not_found", "Submission not found.", 404);
        }
        if (submission.status === "submitted") {
            await client.query("commit");
            return { id: submission.id, status: submission.status, retryStatus: "already_submitted" };
        }
        const retryState = await (0, lender_repo_1.findSubmissionRetryState)(submission.id, client);
        const attemptCount = retryState?.attempt_count ?? 0;
        const maxRetries = config_1.config.lender.retry.maxCount;
        if (attemptCount >= maxRetries) {
            throw new errors_1.AppError("retry_exhausted", "Retry limit reached.", 409);
        }
        if (!submission.payload || typeof submission.payload !== "object") {
            throw new errors_1.AppError("invalid_payload", "Submission payload is missing.", 409);
        }
        const submissionProfile = await (0, SubmissionRouter_1.resolveSubmissionProfile)(submission.lender_id, client);
        const result = await retryExistingSubmission({
            submissionId: submission.id,
            applicationId: submission.application_id,
            lenderId: submission.lender_id,
            submissionMethod: submissionProfile.submissionMethod,
            profile: submissionProfile,
            payload: submission.payload,
            actorUserId: params.actorUserId,
            ...buildRequestMetadata(params),
            attempt: attemptCount + 1,
            client,
        });
        const status = result.value.status;
        const retryStatus = status === "submitted" ? "succeeded" : "pending";
        await (0, lender_repo_1.upsertSubmissionRetryState)({
            submissionId: submission.id,
            status: retryStatus,
            attemptCount: attemptCount + 1,
            nextAttemptAt: retryStatus === "pending" ? calculateNextAttempt(attemptCount + 1) : null,
            lastError: status === "submitted" ? null : "retry_failed",
            canceledAt: null,
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "lender_submission_retried",
            actorUserId: params.actorUserId,
            targetUserId: null,
            targetType: "submission",
            targetId: submission.id,
            ...buildAuditContext(params),
            success: status === "submitted",
            client,
        });
        await client.query("commit");
        return { id: submission.id, status: result.value.status, retryStatus };
    }
    catch (err) {
        await client.query("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function cancelSubmissionRetry(params) {
    const client = await db_1.pool.connect();
    try {
        await client.query("begin");
        const submission = await (0, lender_repo_1.findSubmissionById)(params.submissionId, client);
        if (!submission) {
            throw new errors_1.AppError("not_found", "Submission not found.", 404);
        }
        const retryState = await (0, lender_repo_1.findSubmissionRetryState)(submission.id, client);
        if (!retryState) {
            throw new errors_1.AppError("not_found", "Retry state not found.", 404);
        }
        await (0, lender_repo_1.upsertSubmissionRetryState)({
            submissionId: submission.id,
            status: "canceled",
            attemptCount: retryState.attempt_count,
            nextAttemptAt: null,
            lastError: retryState.last_error,
            canceledAt: new Date(),
            client,
        });
        await (0, audit_service_1.recordAuditEvent)({
            action: "lender_submission_retry_canceled",
            actorUserId: params.actorUserId,
            targetUserId: null,
            targetType: "submission",
            targetId: submission.id,
            ...buildAuditContext(params),
            success: true,
            client,
        });
        await client.query("commit");
        return { id: submission.id, status: "canceled" };
    }
    catch (err) {
        await client.query("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
