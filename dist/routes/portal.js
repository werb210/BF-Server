"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const express_1 = require("express");
const startupState_1 = require("../startupState");
const db_1 = require("../db");
const applications_repo_1 = require("../modules/applications/applications.repo");
const pipelineState_1 = require("../modules/applications/pipelineState");
const safeHandler_1 = require("../middleware/safeHandler");
const applications_controller_1 = require("../controllers/applications.controller");
const rateLimit_1 = require("../middleware/rateLimit");
const auth_1 = require("../middleware/auth");
const roles_1 = require("../auth/roles");
const errors_1 = require("../middleware/errors");
const pipelineState_2 = require("../modules/applications/pipelineState");
const applications_service_1 = require("../modules/applications/applications.service");
const audit_service_1 = require("../modules/audit/audit.service");
const processingStage_service_1 = require("../modules/applications/processingStage.service");
const retry_service_1 = require("../modules/processing/retry.service");
const applicationLifecycle_service_1 = require("../modules/applications/applicationLifecycle.service");
const config_1 = require("../config");
const lenders_repo_1 = require("../repositories/lenders.repo");
const eventBus_1 = require("../events/eventBus");
const readiness_service_1 = require("../modules/readiness/readiness.service");
const toStringSafe_1 = require("../utils/toStringSafe");
const router = (0, express_1.Router)();
const portalLimiter = (0, rateLimit_1.portalRateLimit)();
function ensureReady(res) {
    if (!(0, startupState_1.isReady)()) {
        const status = (0, startupState_1.fetchStatus)();
        res.status(503).json({
            ok: false,
            code: "service_not_ready",
            reason: status.reason,
        });
        return false;
    }
    return true;
}
function ensureAuditHistoryEnabled() {
    if (!config_1.config.flags.auditHistoryEnabled) {
        throw new errors_1.AppError("not_found", "Audit history is disabled.", 404);
    }
}
function parsePagination(query) {
    const limitRaw = typeof query.limit === "string" ? Number(query.limit) : NaN;
    const offsetRaw = typeof query.offset === "string" ? Number(query.offset) : NaN;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    return { limit, offset };
}
router.get("/applications", portalLimiter, (0, safeHandler_1.safeHandler)(async (_req, res) => {
    if (!ensureReady(res)) {
        return;
    }
    try {
        const result = await db_1.pool.runQuery(`select id,
          coalesce(name, business_legal_name) as name,
          pipeline_state,
          created_at
         from applications
         order by created_at desc`);
        const rows = Array.isArray(result?.rows) ? result.rows : [];
        res.status(200).json({
            items: rows.map((row) => ({
                id: row.id,
                name: row.name,
                pipelineState: row.pipeline_state ?? pipelineState_1.ApplicationStage.RECEIVED,
                createdAt: row.created_at,
            })),
        });
    }
    catch (err) {
        res.status(200).json({ items: [] });
    }
}));
router.get("/applications/stages", portalLimiter, (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (!ensureReady(res)) {
        return;
    }
    await (0, applications_controller_1.listApplicationStages)(req, res);
}));
router.get("/applications/:id", portalLimiter, (0, safeHandler_1.safeHandler)(async (req, res) => {
    if (!ensureReady(res)) {
        return;
    }
    const applicationId = (0, toStringSafe_1.toStringSafe)(req.params.id);
    if (!applicationId) {
        res.status(400).json({
            code: "validation_error",
            message: "Application id is required.",
            requestId: res.locals.requestId ?? "unknown",
        });
        return;
    }
    const record = await (0, applications_repo_1.findApplicationById)(applicationId);
    if (!record) {
        res.status(404).json({
            code: "not_found",
            message: "Application not found.",
            requestId: res.locals.requestId ?? "unknown",
        });
        return;
    }
    const documents = await (0, applications_repo_1.listDocumentsByApplicationId)(record.id);
    const documentsWithVersions = await Promise.all(documents.map(async (doc) => {
        const version = await (0, applications_repo_1.findActiveDocumentVersion)({ documentId: doc.id });
        const metadata = version && version.metadata && typeof version.metadata === "object"
            ? version.metadata
            : {};
        return {
            documentId: doc.id,
            applicationId: doc.application_id,
            category: doc.document_type,
            title: doc.title,
            filename: metadata.fileName ?? doc.title,
            mimeType: metadata.mimeType ?? null,
            size: metadata.size ?? null,
            storageKey: metadata.storageKey ?? null,
            version: version?.version ?? null,
            createdAt: doc.created_at,
        };
    }));
    res.status(200).json({
        application: {
            id: record.id,
            name: record.name,
            productType: record.product_type,
            pipelineState: record.pipeline_state,
            createdAt: record.created_at,
            updatedAt: record.updated_at,
            metadata: record.metadata ?? null,
        },
        pipeline: {
            state: record.pipeline_state,
        },
        documents: documentsWithVersions,
    });
}));
router.get("/readiness-leads", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const items = await (0, readiness_service_1.listReadinessLeads)();
    res.status(200).json({ items });
}));
router.post("/readiness-leads/:id/convert", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const leadId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!leadId) {
        throw new errors_1.AppError("validation_error", "Lead id is required.", 400);
    }
    const actorUserId = req.user?.userId;
    if (!actorUserId) {
        throw new errors_1.AppError("unauthorized", "Authentication required.", 401);
    }
    try {
        const { applicationId } = await (0, readiness_service_1.convertReadinessLeadToApplication)(leadId, actorUserId);
        res.status(200).json({ applicationId });
    }
    catch (error) {
        if (error instanceof Error && error.message === "not_found") {
            throw new errors_1.AppError("not_found", "Readiness lead not found.", 404);
        }
        throw error;
    }
}));
router.get("/applications/:id/readiness", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const readinessLead = await (0, readiness_service_1.fetchReadinessLeadByApplicationId)(applicationId);
    if (!readinessLead) {
        res.status(404).json({ error: "not_found" });
        return;
    }
    res.status(200).json({ readinessLead });
}));
router.get("/applications/:id/history", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    ensureAuditHistoryEnabled();
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const actorType = typeof (0, toStringSafe_1.toStringSafe)(req.query.actorType) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.actorType).trim() : "";
    const fromStage = typeof (0, toStringSafe_1.toStringSafe)(req.query.fromStage) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.fromStage).trim() : "";
    const toStage = typeof (0, toStringSafe_1.toStringSafe)(req.query.toStage) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.toStage).trim() : "";
    const trigger = typeof (0, toStringSafe_1.toStringSafe)(req.query.trigger) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.trigger).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values = [applicationId];
    const filters = [];
    if (actorType) {
        values.push(actorType);
        filters.push(`actor_type = $${values.length}`);
    }
    if (fromStage) {
        values.push(fromStage);
        filters.push(`from_stage = $${values.length}`);
    }
    if (toStage) {
        values.push(toStage);
        filters.push(`to_stage = $${values.length}`);
    }
    if (trigger) {
        values.push(trigger);
        filters.push(`trigger = $${values.length}`);
    }
    values.push(limit, offset);
    const filterClause = filters.length > 0 ? `and ${filters.join(" and ")}` : "";
    const result = await db_1.pool.runQuery(`select application_id, from_stage, to_stage, trigger, actor_id, actor_role,
              actor_type, occurred_at, reason
       from application_pipeline_history
       where application_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`, values);
    res.status(200).json({ items: result.rows ?? [] });
}));
router.get("/jobs/:id/history", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    ensureAuditHistoryEnabled();
    const jobId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!jobId) {
        throw new errors_1.AppError("validation_error", "Job id is required.", 400);
    }
    const jobType = typeof (0, toStringSafe_1.toStringSafe)(req.query.jobType) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.jobType).trim() : "";
    const nextStatus = typeof (0, toStringSafe_1.toStringSafe)(req.query.nextStatus) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.nextStatus).trim() : "";
    const actorType = typeof (0, toStringSafe_1.toStringSafe)(req.query.actorType) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.actorType).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values = [jobId];
    const filters = [];
    if (jobType) {
        values.push(jobType);
        filters.push(`job_type = $${values.length}`);
    }
    if (nextStatus) {
        values.push(nextStatus);
        filters.push(`next_status = $${values.length}`);
    }
    if (actorType) {
        values.push(actorType);
        filters.push(`actor_type = $${values.length}`);
    }
    values.push(limit, offset);
    const filterClause = filters.length > 0 ? `and ${filters.join(" and ")}` : "";
    const result = await db_1.pool.runQuery(`select job_id, job_type, application_id, document_id, previous_status, next_status,
              reason, retry_count, last_retry_at, occurred_at, actor_type, actor_id
       from processing_job_history
       where job_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`, values);
    res.status(200).json({ items: result.rows ?? [] });
}));
router.get("/documents/:id/history", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    ensureAuditHistoryEnabled();
    const documentId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!documentId) {
        throw new errors_1.AppError("validation_error", "Document id is required.", 400);
    }
    const nextStatus = typeof (0, toStringSafe_1.toStringSafe)(req.query.nextStatus) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.nextStatus).trim() : "";
    const actorType = typeof (0, toStringSafe_1.toStringSafe)(req.query.actorType) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.actorType).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values = [documentId];
    const filters = [];
    if (nextStatus) {
        values.push(nextStatus);
        filters.push(`next_status = $${values.length}`);
    }
    if (actorType) {
        values.push(actorType);
        filters.push(`actor_type = $${values.length}`);
    }
    values.push(limit, offset);
    const filterClause = filters.length > 0 ? `and ${filters.join(" and ")}` : "";
    const result = await db_1.pool.runQuery(`select application_id, document_id, document_type, actor_id, actor_role, actor_type,
              previous_status, next_status, reason, occurred_at
       from document_status_history
       where document_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`, values);
    res.status(200).json({ items: result.rows ?? [] });
}));
router.post("/jobs/:id/retry", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (!req.user) {
        throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
    }
    const jobId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!jobId) {
        throw new errors_1.AppError("validation_error", "Job id is required.", 400);
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await (0, retry_service_1.retryProcessingJob)({
        jobId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        reason,
        force: true,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
}));
router.post("/applications/:id/retry-job", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (!req.user) {
        throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await (0, retry_service_1.retryProcessingJobForApplication)({
        applicationId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        reason,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
}));
router.post("/applications/:id/promote", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (!req.user) {
        throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
        throw new errors_1.AppError("validation_error", "Reason is required.", 400);
    }
    const nextStageRaw = typeof req.body?.nextStage === "string" ? req.body.nextStage.trim() : "";
    if (nextStageRaw && !(0, pipelineState_2.isPipelineState)(nextStageRaw)) {
        throw new errors_1.AppError("validation_error", "nextStage is invalid.", 400);
    }
    const record = await (0, applications_repo_1.findApplicationById)(applicationId);
    if (!record) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    const currentStage = (0, applicationLifecycle_service_1.assertPipelineState)(record.pipeline_state);
    const nextStage = nextStageRaw && (0, pipelineState_2.isPipelineState)(nextStageRaw)
        ? nextStageRaw
        : (0, applicationLifecycle_service_1.resolveNextPipelineStage)(currentStage);
    if (!nextStage) {
        throw new errors_1.AppError("invalid_transition", "No valid next stage.", 400);
    }
    const transition = (0, applicationLifecycle_service_1.assertPipelineTransition)({
        currentStage,
        nextStage,
        status: null,
    });
    if (!transition.shouldTransition) {
        res.status(200).json({ ok: true, applicationId, nextStage });
        return;
    }
    const promoteMeta = {
        ...(req.ip ? { ip: req.ip } : {}),
        ...(req.get("user-agent") ? { userAgent: req.get("user-agent") } : {}),
    };
    await (0, applications_service_1.transitionPipelineState)({
        applicationId,
        nextState: nextStage,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        trigger: "admin_promotion",
        reason,
        ...promoteMeta,
    });
    await (0, audit_service_1.recordAuditEvent)({
        action: "application_promoted",
        actorUserId: req.user.userId,
        targetUserId: record.owner_user_id,
        targetType: "application",
        targetId: applicationId,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        success: true,
        metadata: {
            from: record.pipeline_state,
            to: nextStage,
            reason,
        },
    });
    await (0, processingStage_service_1.advanceProcessingStage)({ applicationId });
    res.status(200).json({ ok: true, applicationId, nextStage });
}));
router.patch("/applications/:id/status", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (!req.user) {
        throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    if (!status || !(0, pipelineState_2.isPipelineState)(status)) {
        throw new errors_1.AppError("validation_error", "status is invalid.", 400);
    }
    const statusMeta = {
        ...(req.ip ? { ip: req.ip } : {}),
        ...(req.get("user-agent") ? { userAgent: req.get("user-agent") } : {}),
    };
    await (0, applications_service_1.transitionPipelineState)({
        applicationId,
        nextState: status,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        trigger: "manual_status_update",
        reason: typeof req.body?.reason === "string" ? req.body.reason.trim() : null,
        ...statusMeta,
    });
    res.status(200).json({ ok: true, applicationId, status });
}));
router.post("/applications/:id/retry", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    if (!req.user) {
        throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await (0, retry_service_1.retryProcessingJobForApplication)({
        applicationId,
        actorUserId: req.user.userId,
        actorRole: req.user.role,
        reason,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
}));
router.get("/lenders", portalLimiter, (0, safeHandler_1.safeHandler)(async (_req, res) => {
    const lenders = await (0, lenders_repo_1.listLenders)(db_1.pool);
    res.status(200).json({ items: lenders ?? [] });
}));
router.post("/lender-submissions", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.body?.application_id === "string" ? req.body.application_id.trim() : "";
    const selectedLenders = Array.isArray(req.body?.selected_lenders) ? req.body.selected_lenders : [];
    if (!applicationId || selectedLenders.length === 0) {
        throw new errors_1.AppError("validation_error", "application_id and selected_lenders are required.", 400);
    }
    const submissions = [];
    for (const lenderId of selectedLenders) {
        const result = await db_1.pool.runQuery(`insert into lender_submissions (id, application_id, lender_id, status, idempotency_key, payload, submitted_at, created_at, updated_at)
         values ($1, $2, $3, 'submitted', $4, $5, now(), now(), now())
         on conflict (application_id, lender_id) do update
         set status = excluded.status,
             payload = excluded.payload,
             submitted_at = now(),
             updated_at = now()
         returning id, application_id, lender_id, status, submitted_at, created_at`, [(0, crypto_1.randomUUID)(), applicationId, String(lenderId), (0, crypto_1.randomUUID)(), JSON.stringify({ package: 'generated', documents: 'attached', credit_summary: 'attached' })]);
        if (result.rows[0]) {
            submissions.push(result.rows[0]);
            eventBus_1.eventBus.emit("lender_submission_created", {
                submissionId: result.rows[0].id,
                applicationId,
                lenderId: result.rows[0].lender_id,
            });
        }
    }
    res.status(201).json({ submissions });
}));
router.get("/offers", portalLimiter, (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.query.applicationId) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.applicationId).trim() : "";
    const query = applicationId
        ? {
            text: `select id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, created_at, updated_at
                 from offers
                 where application_id = $1
                 order by updated_at desc`,
            values: [applicationId],
        }
        : {
            text: `select id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, created_at, updated_at
                 from offers
                 order by updated_at desc
                 limit 100`,
            values: [],
        };
    const rows = await db_1.pool.runQuery(query.text, query.values);
    res.status(200).json({ items: rows.rows });
}));
router.post("/offers", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lenderName = typeof req.body?.lenderName === "string" ? req.body.lenderName.trim() : "";
    if (!applicationId || !lenderName) {
        throw new errors_1.AppError("validation_error", "applicationId and lenderName are required.", 400);
    }
    const result = await db_1.pool.runQuery(`insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, 'created'), $12, now(), now())
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`, [
        (0, crypto_1.randomUUID)(),
        applicationId,
        lenderName,
        req.body?.amount ?? null,
        req.body?.rateFactor ?? null,
        req.body?.term ?? null,
        req.body?.paymentFrequency ?? null,
        req.body?.expiry ?? null,
        req.body?.documentUrl ?? null,
        Boolean(req.body?.recommended),
        typeof req.body?.status === "string" ? req.body.status.trim() : "created",
        typeof req.body?.notes === "string" ? req.body.notes.trim() : null,
    ]);
    if (result.rows[0]) {
        eventBus_1.eventBus.emit("offer_created", { offerId: result.rows[0].id, applicationId });
    }
    res.status(201).json({ offer: result.rows[0] });
}));
router.patch("/offers/:id/status", auth_1.requireAuth, portalLimiter, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const id = typeof (0, toStringSafe_1.toStringSafe)(req.params.id) === "string" ? (0, toStringSafe_1.toStringSafe)(req.params.id).trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
        throw new errors_1.AppError("validation_error", "Valid status is required.", 400);
    }
    const updated = await db_1.pool.runQuery(`update offers
       set status = $2, updated_at = now()
       where id = $1
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`, [id, status]);
    if (!updated.rows[0]) {
        throw new errors_1.AppError("not_found", "Offer not found.", 404);
    }
    if (updated.rows[0] && status === "accepted") {
        eventBus_1.eventBus.emit("offer_accepted", { offerId: updated.rows[0].id, applicationId: updated.rows[0].application_id });
    }
    res.status(200).json({ offer: updated.rows[0] });
}));
exports.default = router;
