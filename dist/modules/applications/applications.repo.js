"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApplication = createApplication;
exports.listApplications = listApplications;
exports.listApplicationPipelineStages = listApplicationPipelineStages;
exports.countApplications = countApplications;
exports.findApplicationById = findApplicationById;
exports.updateApplicationStatus = updateApplicationStatus;
exports.findApplicationOcrSnapshot = findApplicationOcrSnapshot;
exports.updateApplicationOcrInsights = updateApplicationOcrInsights;
exports.updateApplicationPipelineState = updateApplicationPipelineState;
exports.updateApplicationFirstOpenedAt = updateApplicationFirstOpenedAt;
exports.createApplicationStageEvent = createApplicationStageEvent;
exports.listApplicationStageEvents = listApplicationStageEvents;
exports.upsertApplicationRequiredDocument = upsertApplicationRequiredDocument;
exports.ensureApplicationRequiredDocumentDefinition = ensureApplicationRequiredDocumentDefinition;
exports.listApplicationRequiredDocuments = listApplicationRequiredDocuments;
exports.findApplicationRequiredDocumentById = findApplicationRequiredDocumentById;
exports.updateApplicationRequiredDocumentStatusById = updateApplicationRequiredDocumentStatusById;
exports.createDocument = createDocument;
exports.updateDocumentStatus = updateDocumentStatus;
exports.updateDocumentUploadDetails = updateDocumentUploadDetails;
exports.findDocumentById = findDocumentById;
exports.findDocumentByApplicationAndType = findDocumentByApplicationAndType;
exports.listDocumentsByApplicationId = listDocumentsByApplicationId;
exports.listDocumentsWithLatestVersion = listDocumentsWithLatestVersion;
exports.deleteDocumentById = deleteDocumentById;
exports.fetchLatestDocumentVersion = fetchLatestDocumentVersion;
exports.createDocumentVersion = createDocumentVersion;
exports.findDocumentVersionById = findDocumentVersionById;
exports.findDocumentVersionReview = findDocumentVersionReview;
exports.findAcceptedDocumentVersion = findAcceptedDocumentVersion;
exports.createDocumentVersionReview = createDocumentVersionReview;
exports.findLatestDocumentVersionStatus = findLatestDocumentVersionStatus;
exports.listLatestAcceptedDocumentVersions = listLatestAcceptedDocumentVersions;
exports.findActiveDocumentVersion = findActiveDocumentVersion;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
const pipelineState_1 = require("./pipelineState");
const logger_1 = require("../../observability/logger");
const errors_1 = require("../../middleware/errors");
const PIPELINE_ERROR_CODES = new Set(["22P02", "23514"]);
function isPipelineConstraintError(err) {
    const code = err.code;
    return typeof code === "string" && PIPELINE_ERROR_CODES.has(code);
}
function requireRow(rows, context) {
    const row = rows[0];
    if (!row) {
        throw new errors_1.AppError("data_error", `Missing ${context} record.`, 500);
    }
    return row;
}
function resolveInitialPipelineState(productCategory) {
    return productCategory.trim().toLowerCase() === "startup"
        ? pipelineState_1.ApplicationStage.STARTUP
        : pipelineState_1.ApplicationStage.RECEIVED;
}
async function createApplication(params) {
    const runner = params.client ?? db_1.pool;
    const productCategory = params.productCategory ?? params.productType;
    const pipelineState = resolveInitialPipelineState(productCategory);
    const startupFlag = pipelineState === pipelineState_1.ApplicationStage.STARTUP;
    let res;
    try {
        res = await runner.query(`insert into applications
       (id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, lender_id, lender_product_id, requested_amount, source, startup_flag, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, now(), now())
       returning id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, processing_stage, lender_id, lender_product_id, requested_amount, first_opened_at, ocr_completed_at, banking_completed_at, credit_summary_completed_at, startup_flag, created_at, updated_at`, [
            (0, crypto_1.randomUUID)(),
            params.ownerUserId,
            params.name,
            params.metadata,
            params.productType,
            productCategory,
            pipelineState,
            params.lenderId ?? null,
            params.lenderProductId ?? null,
            params.requestedAmount ?? null,
            params.source ?? null,
            startupFlag,
        ]);
    }
    catch (err) {
        if (isPipelineConstraintError(err)) {
            (0, logger_1.logError)("pipeline_enum_mismatch", {
                route: "/api/applications",
                code: err.code,
                message: err instanceof Error ? err.message : String(err),
            });
            throw new errors_1.AppError("validation_error", "Invalid pipeline state.", 400);
        }
        throw err;
    }
    const record = requireRow(res.rows, "application");
    await createApplicationStageEvent({
        applicationId: record.id,
        fromStage: null,
        toStage: pipelineState,
        trigger: params.trigger ?? "application_created",
        triggeredBy: params.triggeredBy ?? "system",
        client: runner,
    });
    return record;
}
async function listApplications(params) {
    const runner = params?.client ?? db_1.pool;
    const limit = params?.limit ?? 50;
    const offset = params?.offset ?? 0;
    const stage = params?.stage?.trim();
    const values = [limit, offset];
    const stageClause = stage
        ? `where lower(coalesce(pipeline_state, 'received')) = lower($${values.length + 1})`
        : "";
    if (stage) {
        values.push(stage);
    }
    const res = await runner.query(`select id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, processing_stage, lender_id, lender_product_id, requested_amount, first_opened_at, ocr_completed_at, banking_completed_at, credit_summary_completed_at, startup_flag, created_at, updated_at
     from applications
     ${stageClause}
     order by created_at desc
     limit $1 offset $2`, values);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function listApplicationPipelineStages(client) {
    const runner = client ?? db_1.pool;
    try {
        const res = await runner.query(`SELECT DISTINCT pipeline_state
       FROM applications
       ORDER BY pipeline_state`);
        return Array.isArray(res.rows)
            ? res.rows
                .map((row) => row.pipeline_state)
                .filter((state) => Boolean(state))
            : [];
    }
    catch (err) {
        (0, logger_1.logError)("pipeline_stages_query_failed", {
            route: "/api/portal/applications/stages",
            stack: err instanceof Error ? err.stack : undefined,
        });
        return [];
    }
}
async function countApplications(client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query("select count(*)::int as total from applications");
    const first = res.rows[0];
    return Number(first?.total ?? 0);
}
async function findApplicationById(id, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, status, processing_stage, lender_id, lender_product_id, requested_amount, first_opened_at, ocr_completed_at, banking_completed_at, credit_summary_completed_at, startup_flag, created_at, updated_at
     from applications
     where id = $1
     limit 1`, [id]);
    const first = res.rows[0];
    return first ?? null;
}
async function updateApplicationStatus(params) {
    const runner = params.client ?? db_1.pool;
    await runner.query(`update applications
     set status = $1, updated_at = now()
     where id = $2`, [params.status, params.applicationId]);
}
async function findApplicationOcrSnapshot(applicationId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id,
            ocr_missing_fields,
            ocr_conflicting_fields,
            ocr_has_missing_fields,
            ocr_has_conflicts
     from applications
     where id = $1
     limit 1`, [applicationId]);
    return res.rows[0] ?? null;
}
async function updateApplicationOcrInsights(params) {
    const runner = params.client ?? db_1.pool;
    await runner.query(`update applications
     set ocr_missing_fields = $2::jsonb,
         ocr_conflicting_fields = $3::jsonb,
         ocr_normalized_values = $4::jsonb,
         ocr_has_missing_fields = $5,
         ocr_has_conflicts = $6,
         ocr_insights_updated_at = now(),
         updated_at = now()
     where id = $1`, [
        params.applicationId,
        JSON.stringify(params.missingFields),
        JSON.stringify(params.conflictingFields),
        JSON.stringify(params.normalizedValues),
        params.missingFields.length > 0,
        params.conflictingFields.length > 0,
    ]);
}
async function updateApplicationPipelineState(params) {
    const runner = params.client ?? db_1.pool;
    try {
        await runner.query(`update applications
       set pipeline_state = $1,
           current_stage = $1,
           application_status = lower($1),
           is_completed = case when $1 = 'OFF_TO_LENDER' then true else is_completed end,
           last_updated = now(),
           updated_at = now()
       where id = $2`, [params.pipelineState, params.applicationId]);
    }
    catch (err) {
        if (isPipelineConstraintError(err)) {
            (0, logger_1.logError)("pipeline_constraint_violation", {
                route: "/api/applications/:id/pipeline",
                code: err.code,
                message: err instanceof Error ? err.message : String(err),
            });
            throw new errors_1.AppError("validation_error", "Invalid pipeline state.", 400);
        }
        throw err;
    }
}
async function updateApplicationFirstOpenedAt(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update applications
     set first_opened_at = now(),
         updated_at = now()
     where id = $1
       and first_opened_at is null`, [params.applicationId]);
    return (res.rowCount ?? 0) > 0;
}
async function createApplicationStageEvent(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into application_stage_events
     (id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at`, [
        (0, crypto_1.randomUUID)(),
        params.applicationId,
        params.fromStage,
        params.toStage,
        params.trigger,
        params.triggeredBy,
        params.reason ?? null,
    ]);
    return requireRow(res.rows, "application stage event");
}
async function listApplicationStageEvents(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at
     from application_stage_events
     where application_id = $1
     order by created_at asc`, [params.applicationId]);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function upsertApplicationRequiredDocument(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into application_required_documents
     (id, application_id, document_category, is_required, status, created_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (application_id, document_category) do update
     set status = excluded.status,
         is_required = excluded.is_required
     returning id, application_id, document_category, is_required, status, created_at`, [
        (0, crypto_1.randomUUID)(),
        params.applicationId,
        params.documentCategory,
        params.isRequired,
        params.status,
    ]);
    return requireRow(res.rows, "application required document");
}
async function ensureApplicationRequiredDocumentDefinition(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into application_required_documents
     (id, application_id, document_category, is_required, status, created_at)
     values ($1, $2, $3, $4, 'missing', now())
     on conflict (application_id, document_category) do update
     set is_required = excluded.is_required
     returning id, application_id, document_category, is_required, status, created_at`, [
        (0, crypto_1.randomUUID)(),
        params.applicationId,
        params.documentCategory,
        params.isRequired,
    ]);
    return requireRow(res.rows, "application required document");
}
async function listApplicationRequiredDocuments(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, document_category, is_required, status, created_at
     from application_required_documents
     where application_id = $1
     order by document_category asc`, [params.applicationId]);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function findApplicationRequiredDocumentById(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, document_category, is_required, status, created_at
     from application_required_documents
     where id = $1
     limit 1`, [params.documentId]);
    return res.rows[0] ?? null;
}
async function updateApplicationRequiredDocumentStatusById(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update application_required_documents
     set status = $1
     where id = $2
     returning id, application_id, document_category, is_required, status, created_at`, [params.status, params.documentId]);
    return res.rows[0] ?? null;
}
async function createDocument(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into documents
     (id, application_id, owner_user_id, title, document_type, filename, storage_key, uploaded_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'client'), now(), now())
     returning id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at`, [
        (0, crypto_1.randomUUID)(),
        params.applicationId,
        params.ownerUserId,
        params.title,
        params.documentType,
        params.filename ?? null,
        params.storageKey ?? null,
        params.uploadedBy ?? null,
    ]);
    return requireRow(res.rows, "document");
}
async function updateDocumentStatus(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update documents
     set status = $1,
         rejection_reason = $2,
         updated_at = now()
     where id = $3
     returning id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at`, [params.status, params.rejectionReason ?? null, params.documentId]);
    return res.rows[0] ?? null;
}
async function updateDocumentUploadDetails(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`update documents
     set status = $1,
         filename = $2,
         storage_key = $3,
         uploaded_by = coalesce($4, uploaded_by),
         updated_at = now()
     where id = $5
     returning id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at`, [
        params.status,
        params.filename ?? null,
        params.storageKey ?? null,
        params.uploadedBy ?? null,
        params.documentId,
    ]);
    return res.rows[0] ?? null;
}
async function findDocumentById(id, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at
     from documents
     where id = $1
     limit 1`, [id]);
    const first = res.rows[0];
    return first ?? null;
}
async function findDocumentByApplicationAndType(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at
     from documents
     where application_id = $1
       and document_type = $2
     limit 1`, [params.applicationId, params.documentType]);
    const first = res.rows[0];
    return first ?? null;
}
async function listDocumentsByApplicationId(applicationId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at
     from documents
     where application_id = $1
     order by created_at asc`, [applicationId]);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function listDocumentsWithLatestVersion(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select d.id,
            d.application_id,
            d.owner_user_id,
            d.title,
            d.document_type,
            d.status,
            d.filename,
            d.storage_key,
            d.uploaded_by,
            d.rejection_reason,
            d.created_at,
            d.updated_at,
            dv.id as version_id,
            dv.version,
            dv.metadata,
            r.status as review_status
     from documents d
     left join (
       select distinct on (document_id)
         id,
         document_id,
         version,
         metadata
       from document_versions
       order by document_id, version desc
     ) dv on dv.document_id = d.id
     left join document_version_reviews r on r.document_version_id = dv.id
     where d.application_id = $1
     order by d.created_at asc`, [params.applicationId]);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function deleteDocumentById(params) {
    const runner = params.client ?? db_1.pool;
    await runner.query("delete from documents where id = $1", [params.documentId]);
}
async function fetchLatestDocumentVersion(documentId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select coalesce(max(version), 0) as version
     from document_versions
     where document_id = $1`, [documentId]);
    const first = res.rows[0];
    return Number(first?.version ?? 0);
}
async function createDocumentVersion(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into document_versions
     (id, document_id, version, blob_name, hash, metadata, content, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id, document_id, version, blob_name, hash, metadata, content, created_at`, [
        (0, crypto_1.randomUUID)(),
        params.documentId,
        params.version,
        params.blobName ?? null,
        params.hash ?? null,
        params.metadata,
        params.content,
    ]);
    return requireRow(res.rows, "document version");
}
async function findDocumentVersionById(id, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, document_id, version, blob_name, hash, metadata, content, created_at
     from document_versions
     where id = $1
     limit 1`, [id]);
    const first = res.rows[0];
    return first ?? null;
}
async function findDocumentVersionReview(documentVersionId, client) {
    const runner = client ?? db_1.pool;
    const res = await runner.query(`select id, document_version_id, status, reviewed_by_user_id, reviewed_at
     from document_version_reviews
     where document_version_id = $1
     limit 1`, [documentVersionId]);
    const first = res.rows[0];
    return first ?? null;
}
async function findAcceptedDocumentVersion(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select dv.id, dv.document_id, dv.version, dv.blob_name, dv.hash, dv.metadata, dv.content, dv.created_at
     from document_versions dv
     join document_version_reviews r on r.document_version_id = dv.id
     where dv.document_id = $1
       and r.status = 'accepted'
     order by dv.version desc
     limit 1`, [params.documentId]);
    const first = res.rows[0];
    return first ?? null;
}
async function createDocumentVersionReview(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`insert into document_version_reviews
     (id, document_version_id, status, reviewed_by_user_id, reviewed_at)
     values ($1, $2, $3, $4, now())
     returning id, document_version_id, status, reviewed_by_user_id, reviewed_at`, [(0, crypto_1.randomUUID)(), params.documentVersionId, params.status, params.reviewedByUserId]);
    return requireRow(res.rows, "document version review");
}
async function findLatestDocumentVersionStatus(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select d.id as document_id,
            d.document_type,
            dv.id as version_id,
            dv.version,
            r.status
     from documents d
     join document_versions dv on dv.document_id = d.id
     left join document_version_reviews r on r.document_version_id = dv.id
     where d.application_id = $1
       and d.document_type = $2
     order by dv.version desc
     limit 1`, [params.applicationId, params.documentType]);
    const first = res.rows[0];
    return first ?? null;
}
async function listLatestAcceptedDocumentVersions(params) {
    const runner = params.client ?? db_1.pool;
    const res = await runner.query(`select distinct on (d.document_type)
        d.id as document_id,
        d.document_type,
        d.title,
        dv.id as version_id,
        dv.version,
        dv.metadata,
        dv.content
     from documents d
     join document_versions dv on dv.document_id = d.id
     join document_version_reviews r on r.document_version_id = dv.id
     where d.application_id = $1
       and d.document_type = any($2)
       and r.status = 'accepted'
     order by d.document_type, dv.version desc`, [params.applicationId, params.documentTypes]);
    return Array.isArray(res.rows) ? res.rows : [];
}
async function findActiveDocumentVersion(params) {
    const runner = params.client ?? db_1.pool;
    const accepted = await runner.query(`select dv.id, dv.document_id, dv.version, dv.blob_name, dv.hash, dv.metadata, dv.content, dv.created_at
     from document_versions dv
     join document_version_reviews r on r.document_version_id = dv.id
     where dv.document_id = $1
       and r.status = 'accepted'
     order by dv.version desc
     limit 1`, [params.documentId]);
    const acceptedRecord = accepted.rows[0];
    if (acceptedRecord) {
        return acceptedRecord;
    }
    const latest = await runner.query(`select id, document_id, version, blob_name, hash, metadata, content, created_at
     from document_versions
     where document_id = $1
     order by version desc
     limit 1`, [params.documentId]);
    const latestRecord = latest.rows[0];
    return latestRecord ?? null;
}
