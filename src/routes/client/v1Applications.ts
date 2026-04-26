import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool, runQuery } from "../../db.js";
import { config } from "../../config/index.js";
import { AppError } from "../../middleware/errors.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { ApplicationStage } from "../../modules/applications/pipelineState.js";
import { findApplicationById } from "../../modules/applications/applications.repo.js";
import { logAnalyticsEvent } from "../../services/analyticsService.js";
import { eventBus } from "../../events/eventBus.js";
import { createContact, findOrCreateContactByEmailAndCompany } from "../../services/contacts.js";
import { findOrCreateCompanyByNameAndSilo } from "../../services/companies.js";
import { linkContactToApplication } from "../../services/applicationContacts.js";
import { logError, logInfo } from "../../observability/logger.js";

const router = Router();
// V1 contract: POST /api/client/applications

type TokenApplicationRow = { id: string; silo: string | null; owner_user_id: string | null };

// RFC 4122 v1-v5 UUID. The applications.id column is uuid, so any cast of a
// non-uuid value (e.g. legacy "local-..." placeholders) throws 22P02 which the
// safeHandler surfaces as a 500. Validate up front and return the same stale-
// token 410 the route already throws on "not found" so the client self-heals.
const APPLICATION_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function loadApplicationByToken(token: string): Promise<TokenApplicationRow | null> {
  const direct = await pool.query<TokenApplicationRow>(
    `SELECT id, silo, owner_user_id
     FROM applications
     WHERE id = $1
     LIMIT 1`,
    [token]
  );
  if (direct.rows[0]) {
    return direct.rows[0];
  }

  const continuation = await pool.query<TokenApplicationRow>(
    `SELECT a.id, a.silo, a.owner_user_id
     FROM application_continuations ac
     JOIN applications a ON a.id = ac.converted_application_id
     WHERE ac.token = $1
     LIMIT 1`,
    [token]
  );
  return continuation.rows[0] ?? null;
}

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
    const { getSilo } = await import("../../middleware/silo.js");
    const silo = getSilo(res);
    await runQuery(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, status, lender_id, lender_product_id, requested_amount, source, silo, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
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
        silo,
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

router.post(
  "/applications/:token/submit",
  safeHandler(async (req: any, res: any) => {
    const token = typeof req.params.token === "string" ? req.params.token.trim() : "";
    if (!token) {
      return res.status(400).json({ error: { message: "invalid_token" } });
    }

    const { app: legacyApp, normalized } = req.body ?? {};
    const application = await loadApplicationByToken(token);
    if (!application) {
      return res.status(404).json({ error: { message: "application_not_found" } });
    }

    const silo = application.silo || "BF";
    const ownerId = application.owner_user_id || null;

    if (legacyApp) {
      await pool.query(
        "UPDATE applications SET form_data = $1, status = COALESCE(status, 'submitted'), submitted_at = NOW() WHERE id = $2",
        [JSON.stringify(legacyApp), application.id]
      );
    }

    if (!normalized) {
      return res.json({ ok: true, applicationId: application.id, mode: "legacy" });
    }

    if (!normalized?.company?.name || !normalized?.applicant?.first_name || !normalized?.applicant?.last_name) {
      return res.status(400).json({ error: { message: "normalized_required_fields_missing" } });
    }

    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");

      const companyInput = { ...normalized.company, silo, owner_id: ownerId };
      const { row: company } = await findOrCreateCompanyByNameAndSilo(tx, companyInput.name, silo, companyInput);

      const applicantInput = {
        ...normalized.applicant,
        role: "applicant" as const,
        is_primary_applicant: true,
        company_id: company.id,
        silo,
        owner_id: ownerId,
      };

      const { row: applicant } = applicantInput.email
        ? await findOrCreateContactByEmailAndCompany(tx, applicantInput.email, company.id, silo, applicantInput)
        : { row: await createContact(tx, applicantInput) };

      let partner: { id: string } | null = null;
      if (normalized.partner && normalized.partner.first_name && normalized.partner.last_name) {
        const partnerInput = {
          ...normalized.partner,
          role: "partner" as const,
          is_primary_applicant: false,
          company_id: company.id,
          silo,
          owner_id: ownerId,
        };
        const result = partnerInput.email
          ? await findOrCreateContactByEmailAndCompany(tx, partnerInput.email, company.id, silo, partnerInput)
          : { row: await createContact(tx, partnerInput) };
        partner = result.row;
      }

      await linkContactToApplication(tx, application.id, applicant.id, "applicant");
      if (partner) {
        await linkContactToApplication(tx, application.id, partner.id, "partner");
      }

      await tx.query(
        "UPDATE applications SET company_id = $1 WHERE id = $2 AND (company_id IS NULL OR company_id = $1)",
        [company.id, application.id]
      );

      await tx.query("COMMIT");

      logInfo("submit_normalize_completed", {
        event: "submit_normalize_completed",
        applicationId: application.id,
        companyId: company.id,
        applicantId: applicant.id,
        partnerId: partner?.id ?? null,
        mode: "normalized",
      });

      return res.json({
        ok: true,
        applicationId: application.id,
        mode: "normalized",
        companyId: company.id,
        applicantContactId: applicant.id,
        partnerContactId: partner?.id ?? null,
      });
    } catch (err: any) {
      await tx.query("ROLLBACK").catch(() => {});
      logError("submit_normalize_failed", {
        event: "submit_normalize_failed",
        token,
        err: String(err),
        code: err?.code,
      });
      return res.status(500).json({ error: { message: "submit_failed", code: err?.code } });
    } finally {
      tx.release();
    }
  })
);

router.patch(
  "/applications/:id",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    if (!APPLICATION_ID_UUID_RE.test(applicationId)) {
      throw new AppError(
        "application_token_stale",
        "Application not found. Please restart your application from the beginning.",
        410,
        { applicationId }
      );
    }
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid application patch payload.", 400);
    }
    const application = await findApplicationById(applicationId);
    if (!application) {
      throw new AppError(
        "application_token_stale",
        "Application not found. Please restart your application from the beginning.",
        410,
        { applicationId }
      );
    }
    const nextName = parsed.data.business_name ?? application.name;
    const nextRequestedAmount = parsed.data.requested_amount ?? application.requested_amount ?? null;
    const existingMeta = application.metadata && typeof application.metadata === "object"
      ? application.metadata as Record<string, unknown>
      : {};
    const incomingMeta = parsed.data.metadata ?? {};
    const nextMetadata = { ...existingMeta, ...incomingMeta };

    await runQuery(
      `update applications
       set name = $2,
           requested_amount = $3,
           metadata = $4,
           updated_at = now()
       where id = $1`,
      [applicationId, nextName, nextRequestedAmount, nextMetadata]
    );
    const updated = await findApplicationById(applicationId);
    res.status(200).json({
      status: "ok",
      data: {
        application: {
          id: updated?.id ?? applicationId,
          name: updated?.name ?? nextName,
          pipelineState: updated?.pipeline_state ?? application.pipeline_state,
          requestedAmount: updated?.requested_amount ?? nextRequestedAmount,
        },
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
