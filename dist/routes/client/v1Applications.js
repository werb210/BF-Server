"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../db");
const config_1 = require("../../config");
const errors_1 = require("../../middleware/errors");
const safeHandler_1 = require("../../middleware/safeHandler");
const pipelineState_1 = require("../../modules/applications/pipelineState");
const applications_repo_1 = require("../../modules/applications/applications.repo");
const analyticsService_1 = require("../../services/analyticsService");
const eventBus_1 = require("../../events/eventBus");
const router = (0, express_1.Router)();
// V1 contract: POST /api/client/applications
const createSchema = zod_1.z.object({
    business_name: zod_1.z.string().min(1),
    requested_amount: zod_1.z.number().positive(),
    lender_id: zod_1.z.string().uuid(),
    product_id: zod_1.z.string().uuid(),
    product_category: zod_1.z.string().min(1).optional(),
    kyc_responses: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
});
const patchSchema = zod_1.z.object({
    business_name: zod_1.z.string().min(1).optional(),
    requested_amount: zod_1.z.number().positive().optional(),
    metadata: zod_1.z.record(zod_1.z.string(), zod_1.z.unknown()).optional(),
    current_step: zod_1.z.number().int().positive().optional(),
});
router.post("/applications", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid application payload.", 400);
    }
    const { business_name, requested_amount, lender_id, product_id, product_category, kyc_responses } = parsed.data;
    const applicationId = (0, crypto_1.randomUUID)();
    await (0, db_1.runQuery)(`insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, status, lender_id, lender_product_id, requested_amount, source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())`, [
        applicationId,
        config_1.config.client.submissionOwnerUserId,
        business_name,
        {
            ...(kyc_responses ? { kyc_responses } : {}),
            ...(product_category ? { product_category } : {}),
        },
        "standard",
        pipelineState_1.ApplicationStage.RECEIVED,
        pipelineState_1.ApplicationStage.RECEIVED,
        lender_id,
        product_id,
        requested_amount,
        "client",
    ]);
    if (typeof req.body?.readinessScore === "number") {
        await (0, analyticsService_1.logAnalyticsEvent)({
            event: "readiness_score",
            metadata: {
                score: req.body.readinessScore,
                applicationId,
            },
            ...(req.ip ? { ip: req.ip } : {}),
            ...(req.headers["user-agent"] ? { userAgent: req.headers["user-agent"] } : {}),
        });
    }
    res.status(201).json({
        application: {
            id: applicationId,
            name: business_name,
            pipelineState: pipelineState_1.ApplicationStage.RECEIVED,
            requestedAmount: requested_amount,
        },
    });
    eventBus_1.eventBus.emit("application_created", { applicationId });
}));
router.patch("/applications/:id", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid application patch payload.", 400);
    }
    const application = await (0, applications_repo_1.findApplicationById)(applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    const nextName = parsed.data.business_name ?? application.name;
    const nextRequestedAmount = parsed.data.requested_amount ?? application.requested_amount ?? null;
    const nextMetadata = parsed.data.metadata ?? application.metadata ?? null;
    const nextCurrentStep = parsed.data.current_step ?? null;
    await (0, db_1.runQuery)(`update applications
       set name = $2,
           requested_amount = $3,
           metadata = $4,
           current_step = coalesce($5, current_step),
           last_updated = now(),
           updated_at = now()
       where id = $1`, [applicationId, nextName, nextRequestedAmount, nextMetadata, nextCurrentStep]);
    const updated = await (0, applications_repo_1.findApplicationById)(applicationId);
    res.status(200).json({
        application: {
            id: updated?.id ?? applicationId,
            name: updated?.name ?? nextName,
            pipelineState: updated?.pipeline_state ?? application.pipeline_state,
            requestedAmount: updated?.requested_amount ?? nextRequestedAmount,
        },
    });
}));
router.get("/application/:id/status", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "Application id is required.", 400);
    }
    const application = await (0, applications_repo_1.findApplicationById)(applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    res.status(200).json({
        status: {
            applicationId: application.id,
            pipelineState: application.pipeline_state,
            processingStage: application.processing_stage,
            updatedAt: application.updated_at,
        },
    });
}));
exports.default = router;
