import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool, runQuery } from "../../db.js";
import { config } from "../../config/index.js";
import { AppError } from "../../middleware/errors.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { ApplicationStage, statusFromPipeline } from "../../modules/applications/pipelineState.js";
import { findApplicationById } from "../../modules/applications/applications.repo.js";
import { logAnalyticsEvent } from "../../services/analyticsService.js";
import { eventBus } from "../../events/eventBus.js";
import { createContact, findOrCreateContactByEmailAndCompany } from "../../services/contacts.js";
import { findOrCreateCompanyByNameAndSilo } from "../../services/companies.js";
import { linkContactToApplication } from "../../services/applicationContacts.js";
import { logError, logInfo } from "../../observability/logger.js";
import { mirrorApplicationToCrm } from "../../services/applicationCrmMirror.js"; // BF_APP_TO_CRM_v38
// BF_APP_ID_CAST_v39 — Block 39-A — applications.id comparisons cast to text

const router = Router();

// BF_WIZARD_TO_PORTAL_v33 — shared extraction helpers used by both PATCH and
// /submit so the portal drawer reads the same shape regardless of which path
// the wizard took.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function bfParseAmount(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  const cleaned = String(v).replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function bfIsUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
function bfBuildWizardMetadata(input: Record<string, any> | null | undefined): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  // Mirror keys into the names the portal /:id/details endpoint reads.
  if (input.kyc !== undefined)              { out.kyc = input.kyc; out.financials = input.kyc; }
  if (input.financialProfile !== undefined) { out.kyc = out.kyc ?? input.financialProfile; out.financials = out.financials ?? input.financialProfile; }
  if (input.business !== undefined)         { out.business = input.business; out.company = input.business; }
  if (input.applicant !== undefined)        { out.applicant = input.applicant; out.borrower = input.applicant; }
  if (input.partner !== undefined)          { out.partner = input.partner; }
  if (input.applicant && typeof input.applicant === "object" && (input.applicant as any).partner) {
    out.partner = out.partner ?? (input.applicant as any).partner;
  }
  if (input.product_category !== undefined)     out.product_category = input.product_category;
  if (input.productCategory !== undefined)      out.product_category = out.product_category ?? input.productCategory;
  if (input.selected_product !== undefined)     out.selected_product = input.selected_product;
  if (input.selectedProduct !== undefined)      out.selected_product = out.selected_product ?? input.selectedProduct;
  if (input.selected_product_type !== undefined) out.selected_product_type = input.selected_product_type;
  if (input.selectedProductType !== undefined)   out.selected_product_type = out.selected_product_type ?? input.selectedProductType;
  if (input.readiness_lead_id !== undefined)    out.readiness_lead_id = input.readiness_lead_id;
  if (input.session_token !== undefined)        out.session_token = input.session_token;
  if (input.source !== undefined)               out.source = input.source;
  return out;
}
function bfExtractAppColumns(input: Record<string, any> | null | undefined): {
  requestedAmount: number | null;
  lenderId: string | null;
  lenderProductId: string | null;
} {
  if (!input || typeof input !== "object") return { requestedAmount: null, lenderId: null, lenderProductId: null };
  const sp = (input.selected_product ?? input.selectedProduct ?? null) as Record<string, any> | null;
  const requestedAmount =
    bfParseAmount(input.requested_amount) ??
    bfParseAmount(input.requestedAmount) ??
    bfParseAmount(input.kyc?.fundingAmount) ??
    bfParseAmount(input.financialProfile?.fundingAmount) ??
    null;
  const lenderId =
    (bfIsUuid(input.lender_id) ? input.lender_id : null) ??
    (bfIsUuid(sp?.lender_id) ? sp!.lender_id : null) ??
    null;
  const lenderProductId =
    (bfIsUuid(input.lender_product_id) ? input.lender_product_id : null) ??
    (bfIsUuid(input.selectedProductId) ? input.selectedProductId : null) ??
    (bfIsUuid(sp?.id) ? sp!.id : null) ??
    null;
  return { requestedAmount, lenderId, lenderProductId };
}
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
     WHERE id::text = ($1)::text
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

// BF_CREATE_WIZARD_v34 — Block 34: createSchema must accept the wizard's
// actual payload (same shape as patchSchema in 33-A). Step 4's POST fallback
// previously 400'd every time because none of business_name / requested_amount
// / lender_id / product_id are present at the time of submit. Strict types
// kept on the few fields we still validate; the rest are passthrough into
// applications.metadata via bfBuildWizardMetadata.
const createWizardObject = z.record(z.string(), z.unknown());
const createSchema = z.object({
  business_name: z.string().min(1).optional(),
  requested_amount: z.number().positive().optional(),
  lender_id: z.string().uuid().optional(),
  product_id: z.string().uuid().optional(),
  product_category: z.string().min(1).optional(),
  kyc_responses: z.record(z.string(), z.unknown()).optional(),
  // Wizard-shaped passthrough.
  financialProfile: createWizardObject.optional(),
  business: createWizardObject.optional(),
  applicant: createWizardObject.optional(),
  partner: createWizardObject.optional(),
  kyc: createWizardObject.optional(),
  selected_product: createWizardObject.optional(),
  selected_product_type: z.string().optional(),
  readiness_lead_id: z.string().optional(),
  session_token: z.string().optional(),
  source: z.string().optional(),
});

// BF_WIZARD_TO_PORTAL_v33 — Block 33: PATCH must accept the wizard's actual
// payload shape (financialProfile/business/applicant/partner/kyc/...).
// Every named field is merged into applications.metadata so the portal
// drawer's /:id/details reader (which looks at metadata.kyc, metadata.business,
// metadata.applicant, metadata.financials, metadata.product_category) sees the
// real data. Without this expansion Zod silently strips everything → the
// wizard "saves" but the server keeps NULL, and the portal drawer is empty.
const wizardPatchObject = z.record(z.string(), z.unknown());
const patchSchema = z.object({
  business_name: z.string().min(1).optional(),
  requested_amount: z.number().positive().optional(),
  lender_id: z.string().uuid().optional(),
  lender_product_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  current_step: z.number().int().positive().optional(),
  // Wizard fields — passthrough into metadata.
  financialProfile: wizardPatchObject.optional(),
  business: wizardPatchObject.optional(),
  applicant: wizardPatchObject.optional(),
  partner: wizardPatchObject.optional(),
  kyc: wizardPatchObject.optional(),
  product_category: z.string().optional(),
  selected_product: wizardPatchObject.optional(),
  selected_product_type: z.string().optional(),
  readiness_lead_id: z.string().optional(),
  session_token: z.string().optional(),
  source: z.string().optional(),
});

router.post(
  "/applications",
  safeHandler(async (req: any, res: any, next: any) => {
    // BF_CREATE_WIZARD_v34 — Block 34: accept wizard payload. Derive missing
    // columns from selected_product / business / kyc.fundingAmount instead
    // of rejecting. Persist wizard fields into metadata so the portal drawer
    // sees the same shape it does for PATCHed applications.
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid application payload.", 400);
    }
    const data = parsed.data;
    const wizardMeta = bfBuildWizardMetadata(data as any);
    const wizardCols = bfExtractAppColumns(data as any);
    const businessAny = (data as any).business as Record<string, any> | undefined;
    const business_name =
      data.business_name
      ?? (typeof businessAny?.companyName === "string" && businessAny.companyName.trim() ? businessAny.companyName.trim() : undefined)
      ?? (typeof businessAny?.legalName === "string" && businessAny.legalName.trim() ? businessAny.legalName.trim() : undefined)
      ?? (typeof businessAny?.businessName === "string" && businessAny.businessName.trim() ? businessAny.businessName.trim() : undefined)
      ?? "Untitled Application";
    const requested_amount = data.requested_amount ?? wizardCols.requestedAmount ?? null;
    const lender_id = data.lender_id ?? wizardCols.lenderId ?? null;
    const product_id = data.product_id ?? wizardCols.lenderProductId ?? null;
    const product_category = data.product_category ?? (data as any).selected_product_type ?? null;
    const applicationId = randomUUID();
    const { getSilo } = await import("../../middleware/silo.js");
    const silo = getSilo(res);
    const metadata = {
      ...(data.kyc_responses ? { kyc_responses: data.kyc_responses } : {}),
      ...(product_category ? { product_category } : {}),
      ...wizardMeta,
    };
    await runQuery(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, status, lender_id, lender_product_id, requested_amount, source, silo, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())`,
      [
        applicationId,
        config.client.submissionOwnerUserId,
        business_name,
        metadata,
        "standard",
        ApplicationStage.RECEIVED,
        statusFromPipeline(ApplicationStage.RECEIVED),
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

    if (legacyApp && typeof legacyApp === "object") {
      // BF_WIZARD_TO_PORTAL_v33 — Block 33: write to metadata (jsonb column
      // that exists), NOT form_data (which does not exist in the schema).
      // Mirror wizard fields into the metadata keys the portal /:id/details
      // endpoint reads, and stash the full app blob under metadata.formData
      // for completeness.
      const wizardMeta = bfBuildWizardMetadata(legacyApp as any);
      const wizardCols = bfExtractAppColumns(legacyApp as any);
      const submittedAt = new Date().toISOString();
      const metaPatch = {
        ...wizardMeta,
        formData: legacyApp,
        submittedAt,
      };
      await pool.query(
        `UPDATE applications
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             requested_amount = COALESCE($2, requested_amount),
             lender_id = COALESCE($3, lender_id),
             lender_product_id = COALESCE($4, lender_product_id),
             submitted_at = NOW(),
             updated_at = NOW()
         WHERE id::text = ($5)::text`,
        [
          JSON.stringify(metaPatch),
          wizardCols.requestedAmount,
          wizardCols.lenderId,
          wizardCols.lenderProductId,
          application.id,
        ]
      );

      // BF_APP_TO_CRM_v38 — Block 38-E — fire-and-forget CRM mirror.
      try {
        const md: any = (legacyApp && typeof legacyApp === "object") ? legacyApp : {};
        void mirrorApplicationToCrm({
          applicationId: application.id,
          silo: (silo || "BF").toUpperCase(),
          business: md?.business ?? md?.company ?? null,
          applicant: md?.applicant ?? md?.borrower ?? null,
        });
      } catch { /* never block submit on mirror */ }
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
        "UPDATE applications SET company_id = $1 WHERE id::text = ($2)::text AND (company_id IS NULL OR company_id = $1)",
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
    // BF_WIZARD_TO_PORTAL_v33 — merge wizard payload into metadata so the
    // portal drawer reads it. Also pluck out columnar fields when present.
    const nextName = parsed.data.business_name ?? application.name;
    const wizardMeta = bfBuildWizardMetadata(parsed.data as any);
    const wizardCols = bfExtractAppColumns(parsed.data as any);
    const nextRequestedAmount =
      parsed.data.requested_amount ?? wizardCols.requestedAmount ?? application.requested_amount ?? null;
    const nextLenderId = parsed.data.lender_id ?? wizardCols.lenderId ?? (application as any).lender_id ?? null;
    const nextLenderProductId = parsed.data.lender_product_id ?? wizardCols.lenderProductId ?? (application as any).lender_product_id ?? null;
    const existingMeta = application.metadata && typeof application.metadata === "object"
      ? application.metadata as Record<string, unknown>
      : {};
    const incomingMeta = parsed.data.metadata ?? {};
    const nextMetadata = { ...existingMeta, ...incomingMeta, ...wizardMeta };

    await runQuery(
      `update applications
       set name = $2,
           requested_amount = $3,
           metadata = $4,
           lender_id = COALESCE($5, lender_id),
           lender_product_id = COALESCE($6, lender_product_id),
           updated_at = now()
       where id::text = ($1)::text`,
      [applicationId, nextName, nextRequestedAmount, nextMetadata, nextLenderId, nextLenderProductId]
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
