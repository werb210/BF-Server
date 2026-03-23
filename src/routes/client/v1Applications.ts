import { randomUUID } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../../db";
import { getClientSubmissionOwnerUserId, config } from "../../server/config/config";
import { AppError } from "../../middleware/errors";
import { safeHandler } from "../../middleware/safeHandler";
import { ApplicationStage } from "../../modules/applications/pipelineState";
import { findApplicationById } from "../../modules/applications/applications.repo";
import { logAnalyticsEvent } from "../../services/analyticsService";
import { eventBus } from "../../events/eventBus";

const router = Router();
// V1 contract: POST /api/client/applications

const createSchema = z.object({
  business_name: z.string().min(1),
  requested_amount: z.number().positive(),
  lender_id: z.string().uuid(),
  product_id: z.string().uuid(),
  product_category: z.string().min(1).optional(),
  kyc_responses: z.record(z.string(), z.unknown()).optional(),
});

const patchSchema = z.object({
  business_name: z.string().min(1).optional(),
  requested_amount: z.number().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  current_step: z.number().int().positive().optional(),
});

router.post(
  "/applications",
  safeHandler(async (req: any, res: any, next: any) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid application payload.", 400);
    }
    const { business_name, requested_amount, lender_id, product_id, product_category, kyc_responses } = parsed.data;
    const applicationId = randomUUID();
    await pool.query(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, status, lender_id, lender_product_id, requested_amount, source, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())`,
      [
        applicationId,
        config.client.submissionOwnerUserId,
        business_name,
        {
          ...(kyc_responses ? { kyc_responses } : {}),
          ...(product_category ? { product_category } : {}),
        },
        "standard",
        ApplicationStage.RECEIVED,
        ApplicationStage.RECEIVED,
        lender_id,
        product_id,
        requested_amount,
        "client",
      ]
    );

    if (typeof req.body?.readinessScore === "number") {
      await logAnalyticsEvent({
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
        pipelineState: ApplicationStage.RECEIVED,
        requestedAmount: requested_amount,
      },
    });

    eventBus.emit("application_created", { applicationId });
  })
);

router.patch(
  "/applications/:id",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid application patch payload.", 400);
    }
    const application = await findApplicationById(applicationId);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    const nextName = parsed.data.business_name ?? application.name;
    const nextRequestedAmount =
      parsed.data.requested_amount ?? application.requested_amount ?? null;
    const nextMetadata = parsed.data.metadata ?? application.metadata ?? null;
    const nextCurrentStep = parsed.data.current_step ?? null;
    await pool.query(
      `update applications
       set name = $2,
           requested_amount = $3,
           metadata = $4,
           current_step = coalesce($5, current_step),
           last_updated = now(),
           updated_at = now()
       where id = $1`,
      [applicationId, nextName, nextRequestedAmount, nextMetadata, nextCurrentStep]
    );
    const updated = await findApplicationById(applicationId);
    res.status(200).json({
      application: {
        id: updated?.id ?? applicationId,
        name: updated?.name ?? nextName,
        pipelineState: updated?.pipeline_state ?? application.pipeline_state,
        requestedAmount: updated?.requested_amount ?? nextRequestedAmount,
      },
    });
  })
);

router.get(
  "/application/:id/status",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const application = await findApplicationById(applicationId);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    res.status(200).json({
      status: {
        applicationId: application.id,
        pipelineState: application.pipeline_state,
        processingStage: application.processing_stage,
        updatedAt: application.updated_at,
      },
    });
  })
);

export default router;
