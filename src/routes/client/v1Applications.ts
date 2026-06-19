import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { pool, runQuery } from "../../db.js";
import { config } from "../../config/index.js";
import { AppError } from "../../middleware/errors.js";
import { requireAuth } from "../../middleware/requireAuth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { ApplicationStage, statusFromPipeline } from "../../modules/applications/pipelineState.js";
import {
  findApplicationById,
  listDocumentsByApplicationId,
} from "../../modules/applications/applications.repo.js";
import { logAnalyticsEvent } from "../../services/analyticsService.js";
import { eventBus } from "../../events/eventBus.js";
import { createContact, findOrCreateContactByEmailAndCompany } from "../../services/contacts.js";
import { findOrCreateCompanyByNameAndSilo } from "../../services/companies.js";
import { linkContactToApplication } from "../../services/applicationContacts.js";
import { logError, logInfo } from "../../observability/logger.js";
import { mirrorApplicationToCrm } from "../../services/applicationCrmMirror.js"; // BF_APP_TO_CRM_v38
// BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1
import { postBiHandoff } from "../../services/biHandoff.js";
import { randomUUID as biRandomUUID } from "node:crypto";
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
  // BF_SERVER_BLOCK_v82_DEFER_PERSIST — persist documentsDeferred and other
  // simple flags from the wizard PATCH. Without this, "send docs later"
  // disappears across sessions and the submit gate re-locks.
  if (typeof input.documentsDeferred === "boolean")    out.documentsDeferred = input.documentsDeferred;
  if (typeof input.documents_deferred === "boolean")   out.documentsDeferred = out.documentsDeferred ?? input.documents_deferred;
  if (typeof input.requires_closing_cost_funding === "boolean")
    out.requires_closing_cost_funding = input.requires_closing_cost_funding;
  if (typeof input.requiresClosingCostFunding === "boolean")
    out.requires_closing_cost_funding = out.requires_closing_cost_funding ?? input.requiresClosingCostFunding;
  if (typeof input.currentStep === "number")           out.currentStep = input.currentStep;
  if (typeof input.current_step === "number")          out.currentStep = out.currentStep ?? input.current_step;
  if (typeof input.termsAccepted === "boolean")        out.termsAccepted = input.termsAccepted;
  if (typeof input.typedSignature === "string")        out.typedSignature = input.typedSignature;
  if (typeof input.coApplicantSignature === "string")  out.coApplicantSignature = input.coApplicantSignature;
  if (typeof input.signatureDate === "string")         out.signatureDate = input.signatureDate;
  if (input.pgi_opt_in !== undefined)        out.pgi_opt_in = input.pgi_opt_in;
  if (input.pgiOptIn !== undefined)          out.pgi_opt_in = out.pgi_opt_in ?? input.pgiOptIn;
  if (input.termsAccepted !== undefined ||
      input.typedSignature !== undefined ||
      input.signatureDate !== undefined ||
      input.coApplicantSignature !== undefined) {
    out.signature = {
      termsAccepted: input.termsAccepted ?? null,
      typedSignature: input.typedSignature ?? null,
      coApplicantSignature: input.coApplicantSignature ?? null,
      signatureDate: input.signatureDate ?? null,
    };
  }
  if (typeof input.requires_closing_cost_funding === "boolean") {
    out.requires_closing_cost_funding = input.requires_closing_cost_funding;
  } else if (typeof input.requiresClosingCostFunding === "boolean") {
    out.requires_closing_cost_funding = input.requiresClosingCostFunding;
  }
  return out;
}
function bfExtractAppColumns(input: Record<string, any> | null | undefined): {
  requestedAmount: number | null;
  lenderId: string | null;
  lenderProductId: string | null;
} {
  if (!input || typeof input !== "object") return { requestedAmount: null, lenderId: null, lenderProductId: null };
  const sp = (input.selected_product ?? input.selectedProduct ?? null) as Record<string, any> | null;
  // BF_SERVER_BLOCK_v85_MULTI_LEG_SUBMIT_v1
  // For Capital & Equipment users, the primary application's
  // requested_amount is the CAPITAL amount, not fundingAmount.
  const lookingFor = String(
    input.looking_for ?? input.lookingFor ??
    input.kyc?.lookingFor ?? input.financialProfile?.lookingFor ?? ""
  ).toUpperCase();
  const isCapitalAndEquipment = lookingFor === "BOTH" || lookingFor === "CAPITAL_AND_EQUIPMENT";
  const isEquipmentOnly = lookingFor === "EQUIPMENT" || lookingFor === "EQUIPMENT_FINANCING";
  const requestedAmount = isCapitalAndEquipment
    ? (
        bfParseAmount(input.capital_amount) ??
        bfParseAmount(input.capitalAmount) ??
        bfParseAmount(input.kyc?.capitalAmount) ??
        bfParseAmount(input.kyc?.fundingAmount) ??
        null
      )
    : isEquipmentOnly
      ? (
          bfParseAmount(input.equipment_amount) ??
          bfParseAmount(input.equipmentAmount) ??
          bfParseAmount(input.kyc?.equipmentAmount) ??
          bfParseAmount(input.kyc?.fundingAmount) ??
          null
        )
      : (
          bfParseAmount(input.requested_amount) ??
          bfParseAmount(input.requestedAmount) ??
          bfParseAmount(input.kyc?.fundingAmount) ??
          bfParseAmount(input.financialProfile?.fundingAmount) ??
          null
        );
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
// BF_CREATE_SCHEMA_NULLABLE_v40 — Block 40-B — closing-costs linked
// applications send `requested_amount: null` when the borrower hasn't
// entered an amount yet. Zod's `.optional()` only allows undefined; add
// `.nullable()` so these fields accept null.
const createSchema = z.object({
  business_name: z.string().min(1).nullable().optional(),
  requested_amount: z.number().positive().nullable().optional(),
  lender_id: z.string().uuid().nullable().optional(),
  product_id: z.string().uuid().nullable().optional(),
  product_category: z.string().min(1).nullable().optional(),
  kyc_responses: z.record(z.string(), z.unknown()).optional(),
  // BF_SERVER_BLOCK_v125a_CLOSING_COSTS_END_TO_END_v1 — accept linked-app
  // fields the wizard sends when creating a closing-costs companion at
  // Step 2. Without these, Zod silently strips them; the companion was
  // saved with parent_application_id=NULL and the metadata.kind marker
  // missing, breaking the parent->child relationship and submit-time
  // idempotency.
  parent_application_id: z.string().uuid().nullable().optional(),
  linked_application_token: z.string().optional(),
  linked_application_reason: z.string().optional(),
  kind: z.string().optional(),
  requires_closing_cost_funding: z.boolean().optional(),
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
  // Columnar fields persisted directly to applications.* columns.
  business_name: z.string().min(1).nullable().optional(),
  requested_amount: z.number().positive().nullable().optional(),
  lender_id: z.string().uuid().nullable().optional(),
  lender_product_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),

  // Wizard step tracker — snake_case is the canonical legacy name; the
  // camelCase `currentStep` is added in v82 because the BF-client wizard
  // sends camelCase keys. bfBuildWizardMetadata accepts both and writes
  // a single `currentStep` into metadata.
  current_step: z.number().int().positive().optional(),
  currentStep:  z.number().int().min(1).max(6).optional(),

  // Wizard nested objects — stored under metadata as-is.
  financialProfile: wizardPatchObject.optional(),
  business: wizardPatchObject.optional(),
  applicant: wizardPatchObject.optional(),
  partner: wizardPatchObject.optional(),
  kyc: wizardPatchObject.optional(),

  // Product selection.
  product_category: z.string().optional(),
  selected_product: wizardPatchObject.optional(),
  selected_product_type: z.string().optional(),

  // Lead / session attribution.
  readiness_lead_id: z.string().optional(),
  session_token: z.string().optional(),
  source: z.string().optional(),

  // BF_SERVER_BLOCK_v82_DEFER_PERSIST — wizard state that the PATCH must
  // persist so "send docs later" survives refresh and the submit gates
  // re-enable on resume. Both naming conventions accepted; bfBuildWizardMetadata
  // normalizes to canonical keys.
  documentsDeferred:                z.boolean().optional(),
  documents_deferred:               z.boolean().optional(),
  requires_closing_cost_funding:    z.boolean().optional(),
  requiresClosingCostFunding:       z.boolean().optional(),
  termsAccepted:                    z.boolean().optional(),
  typedSignature:                   z.string().optional(),
  coApplicantSignature:             z.string().optional(),
  signatureDate:                    z.string().optional(),
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
    // BF_SERVER_BLOCK_v125a_CLOSING_COSTS_END_TO_END_v1
    // Detect closing-costs linked application (Step 2 modal flow).
    const parent_application_id = (data as any).parent_application_id ?? null;
    const isClosingCostsCompanion =
      (data as any).kind === "closing_costs" ||
      (data as any).linked_application_reason === "closing_costs";
    const metadata: Record<string, unknown> = {
      ...(data.kyc_responses ? { kyc_responses: data.kyc_responses } : {}),
      ...(product_category ? { product_category } : {}),
      ...wizardMeta,
      ...(isClosingCostsCompanion
        ? {
            closing_cost_companion: true,
            parent_application_id,
            kind: "closing_costs",
            linked_application_reason: (data as any).linked_application_reason ?? "closing_costs",
            companion_origin: "client_step2",
          }
        : {}),
    };
    await runQuery(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, status, lender_id, lender_product_id, requested_amount, source, silo, parent_application_id, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), now())`,
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
        isClosingCostsCompanion ? "closing_costs_companion" : "client",
        silo,
        parent_application_id,
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
    // BF_SERVER_BLOCK_v125a_CLOSING_COSTS_END_TO_END_v1 — also include
    // `token` field at top level so the client's
    // ClientAppStartResponseSchema (z.object({ token: z.string() })) passes.
    // Existing consumers reading res.data.application.id continue to work.
    res.status(201).json({
      token: applicationId,
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
      // BF_SERVER_v70_BLOCK_1_2 — advance pipeline_state on submit.
      // With docs already uploaded -> 'Received'; without -> 'Documents Required'.
      // Only updates pipeline_state if currently null/draft so we don't
      // clobber a stage staff has manually advanced.
      // BF_SERVER_BLOCK_1_32_BACKLOG_CLEANUP — also promote applications.name from the
      // wizard payload when the current name is empty / 'Draft application'.
      // BF_SERVER_BLOCK_v140_WIZARD_BUSINESS_NAME_v1 — wizard's Step 3 writes
      // business.companyName / businessName / legalName, NOT business.name.
      // Reading only `name` left applications.name as 'Draft application' on
      // every submitted app, so pipeline cards rendered "Unnamed application"
      // and the staff drawer's overview tab showed nothing.
      const wizardBusinessName: string | null =
        (legacyApp && typeof legacyApp === 'object'
          ? ((legacyApp as any)?.business?.companyName ??
             (legacyApp as any)?.business?.businessName ??
             (legacyApp as any)?.business?.legalName ??
             (legacyApp as any)?.business?.name ??
             (legacyApp as any)?.company?.name ?? null)
          : null) || null;
      await pool.query(
        `UPDATE applications
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
             requested_amount = COALESCE($2, requested_amount),
             lender_id = COALESCE($3, lender_id),
             lender_product_id = COALESCE($4, lender_product_id),
             name = CASE
               WHEN (name IS NULL OR name = '' OR name ILIKE 'draft%' OR name = 'Draft application')
                 THEN COALESCE($6, name)
               ELSE name
             END,
             submitted_at = NOW(),
             updated_at = NOW(),
             pipeline_state = CASE
               WHEN pipeline_state IS NULL OR pipeline_state IN ('draft','Draft','')
                 THEN CASE
                   WHEN EXISTS (
                     SELECT 1 FROM documents
                      WHERE application_id::text = applications.id::text
                   ) THEN 'Received'
                   ELSE 'Documents Required'
                 END
               ELSE pipeline_state
             END
         WHERE id::text = ($5)::text`,
        [
          JSON.stringify(metaPatch),
          wizardCols.requestedAmount,
          wizardCols.lenderId,
          wizardCols.lenderProductId,
          application.id,
          wizardBusinessName,
        ]
      );
      // BF_SERVER_BLOCK_v711_STAGE2_PROMPTS — after submit, prompt the applicant
      // to complete the product's Stage-2 CMP forms. Insert one CTA message per
      // form (mini-portal renders cta_action="form:<id>" as a tap-to-open button)
      // and send one SMS. Idempotent: skips if form prompts already exist.
      try {
        // BF_SERVER_BLOCK_v721_STAGE2_BUTTONS — greeting + one button per REQUIRED
        // Stage-2 item, sourced from the wizard's computed set; cta_action is the
        // mini-portal chip id so the form opens as a modal.
        const FORM_BY_KEYWORD: Array<[RegExp, string, string]> = [
          [/net worth/i, "networth", "Personal Net Worth"],
          [/flinks|banking connection|connect bank/i, "flinks", "Connect Bank (View-Only)"],
          [/\bcra\b/i, "cra", "CRA Authorization"],
          [/debt/i, "debt", "Debt Stack"],
          [/real estate/i, "realestate", "Real Estate Collateral"],
          [/equipment/i, "equipment", "Equipment Collateral"],
          [/professional advisor|\badvisor/i, "advisors", "Professional Advisors"], // BF_SERVER_BLOCK_v711_ADVISORS_MESSENGER_v1
          [/government issued id|gov.*id|photo id|pieces of/i, "upload", "Upload Government ID"],
        ];
        const v711_already = await pool.query(
          `SELECT 1 FROM communications_messages WHERE application_id = $1 AND (cta_action LIKE 'form:%' OR cta_action IN ('networth','flinks','cra','debt','realestate','equipment','upload','upload_docs')) LIMIT 1`,
          [application.id],
        );
        if (!v711_already.rows.length) {
          const v711_agg: Array<{ document_type?: string; required?: boolean; stage?: number }> =
            (() => {
              try {
                const pr = (legacyApp as any)?.productRequirements;
                const arr = pr?.aggregated ?? (pr ? pr[(legacyApp as any)?.selectedProductId] : null);
                return Array.isArray(arr) ? arr : [];
              } catch { return []; }
            })();
          const v711_forms: Array<{ id: string; name: string }> = [];
          for (const row of v711_agg) {
            if (row?.required === false) continue;
            // BF_SERVER_BLOCK_v711_ADVISORS_MESSENGER_v1 — advisors is inherently a
            // Stage-2 CMP form; seed its messenger step even if the product left it stage 1.
            const v711_isAdvisor = /professional advisor|\badvisor/i.test(String(row?.document_type ?? ""));
            if (!v711_isAdvisor && Number(row?.stage ?? 1) !== 2) continue;
            const hit = FORM_BY_KEYWORD.find(([re]) => re.test(String(row?.document_type ?? "")));
            if (hit && !v711_forms.some((f) => f.id === hit[1])) v711_forms.push({ id: hit[1], name: hit[2] });
          }
          if (v711_forms.length) {
            const v711_contactSilo = `(SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1)`;
            const v711_names = v711_forms.map((f) => f.name);
            const v711_list = v711_names.length === 1
              ? v711_names[0]
              : `${v711_names.slice(0, -1).join(", ")} and ${v711_names[v711_names.length - 1]}`;
            await pool.query(
              `INSERT INTO communications_messages
                 (id, type, direction, status, application_id, contact_id, silo, body, staff_name, created_at)
               VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1,
                 ${v711_contactSilo},
                 COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF'),
                 $2, 'Boreal Financial', now())`,
              [application.id, `Hello, and thank you for your application. You still have a few quick steps to finish — please complete ${v711_list} using the buttons below.`],
            );
            for (const f of v711_forms) {
              await pool.query(
                `INSERT INTO communications_messages
                   (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
                 VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1,
                   ${v711_contactSilo},
                   COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF'),
                   $2, NULL, $3, $4, now())`,
                [application.id, `Complete the ${f.name} step to continue your application.`, f.name, f.id],
              );
            }
            const v711_ph = await pool.query<{ phone: string | null }>(
              `SELECT c.phone FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.id::text = ($1)::text LIMIT 1`,
              [application.id],
            );
            const v711_phone = v711_ph.rows[0]?.phone ?? (() => {
              try { const md = (application as any).metadata ?? {}; const fd = md.formData ?? {}; return fd?.applicant?.phone ?? md?.applicant?.phone ?? null; } catch { return null; }
            })();
            if (v711_phone) {
              const v711_base = (process.env.CLIENT_BASE_URL ?? "https://client.boreal.financial").replace(/\/+$/, "");
              const v711_url = `${v711_base}/application/${application.id}`;
              const { sendSms } = await import("../../modules/notifications/sms.service.js");
              await sendSms({
                to: String(v711_phone),
                message: `Boreal Financial: your application was received. A few quick forms remain — log in to complete them: ${v711_url}`,
              }).catch(() => {});
            }
          }
          // BF_SERVER_BLOCK_v775_DOC_UPLOAD_PROMPT — document uploads are not
          // Stage-2 forms, so a docs-only product (e.g. equipment finance) got no
          // messenger prompt. Post one real "Upload documents" message (button
          // cta_action='upload_docs' opens the client uploader) AND move the card
          // to "Documents Required" — the v70 advance only checks whether ANY
          // document row exists, so an app missing only some required docs wrongly
          // sat in "Received".
          {
            const v775_docs = v711_agg
              .filter((row) => row?.required !== false)
              .map((row) => String(row?.document_type ?? "").trim())
              .filter((dt) => dt && !FORM_BY_KEYWORD.some(([re]) => re.test(dt)));
            if (v775_docs.length) {
              const v775_uniq = Array.from(new Set(v775_docs));
              const v775_list = v775_uniq.length === 1
                ? v775_uniq[0]
                : `${v775_uniq.slice(0, -1).join(", ")} and ${v775_uniq[v775_uniq.length - 1]}`;
              await pool.query(
                `INSERT INTO communications_messages
                   (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
                 VALUES (gen_random_uuid(), 'message', 'outbound', 'sent', $1,
                   (SELECT contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1),
                   COALESCE((SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1), 'BF'),
                   $2, 'Boreal Financial', $3, 'upload_docs', now())`,
                [application.id, `To continue your application, please upload your supporting documents: ${v775_list}.`, "Upload documents"],
              );
              await pool.query(
                `UPDATE applications SET pipeline_state = 'Documents Required', updated_at = now()
                  WHERE id::text = ($1)::text AND pipeline_state IN ('Received','received')`,
                [application.id],
              );
            }
          }
        }
      } catch (v711_err) {
        logError("stage2_prompts_failed_nonfatal", { code: "stage2_prompts_failed_nonfatal", applicationId: application.id, error: v711_err instanceof Error ? v711_err.message : "unknown" });
      }

      try {
        const v650_deferred = Boolean(
          (legacyApp as any)?.documentsDeferred ?? (legacyApp as any)?.documents_deferred
        );
        if (v650_deferred) {
          const v650_contactRes = await pool.query<{ phone: string | null }>(
            `SELECT c.phone FROM applications a
          LEFT JOIN contacts c ON c.id = a.contact_id
              WHERE a.id = $1 LIMIT 1`,
            [application.id]
          );
          const v650_phone = (() => {
            const p = v650_contactRes.rows[0]?.phone;
            if (p) return p;
            try {
              const md = (application as any).metadata ?? {};
              const fd = md.formData ?? {};
              return fd?.applicant?.phone ?? md?.applicant?.phone ?? md?.borrower?.phone ?? null;
            } catch { return null; }
          })();
          if (v650_phone) {
            const clientBase = process.env.CLIENT_BASE_URL ?? "https://client.boreal.financial";
            const portalUrl = `${clientBase.replace(/\/+$/, "")}/application/${application.id}`;
            const { sendSms } = await import("../../modules/notifications/sms.service.js");
            await sendSms({
              to: String(v650_phone),
              message: `Boreal Financial: your application was received. To finish, upload your remaining documents here: ${portalUrl}`,
            }).catch((err) => {
              logError("missing_docs_sms_failed_nonfatal", {
                code: "missing_docs_sms_failed_nonfatal",
                applicationId: application.id,
                error: err instanceof Error ? err.message : "unknown",
              });
            });
          }
        }
      } catch (v650_smsErr) {
        logError("missing_docs_sms_unexpected", {
          code: "missing_docs_sms_unexpected",
          applicationId: application.id,
          error: v650_smsErr instanceof Error ? v650_smsErr.message : "unknown",
        });
      }
      // BF_SERVER_BLOCK_v330_MULTI_APP_PGI_HANDOFF_v1
      // Hoist the leg/companion IDs + amounts so the PGI block at the
      // end of submit can dispatch one BI handoff per funding row.
      let v330_equipmentLegId: string | null = null;
      let v330_equipmentLegAmount: number | null = null;
      let v330_companionLegId: string | null = null;
      let v330_companionLegAmount: number | null = null;

      // BF_SERVER_BLOCK_v85_MULTI_LEG_SUBMIT_v1
      // Capital & Equipment fan-out: when the user selected
      // lookingFor === BOTH on Step 1, primary app holds the capital
      // leg; we insert a second application for the equipment leg
      // with shared metadata and a parent_application_id link.
      try {
        const lookingForForFanOut = String(
          (legacyApp as any)?.looking_for ??
          (legacyApp as any)?.lookingFor ??
          (legacyApp as any)?.kyc?.lookingFor ??
          ""
        ).toUpperCase();
        const isCapitalAndEquipment =
          lookingForForFanOut === "BOTH" ||
          lookingForForFanOut === "CAPITAL_AND_EQUIPMENT";
        if (isCapitalAndEquipment) {
          const equipmentAmount =
            bfParseAmount((legacyApp as any)?.equipment_amount) ??
            bfParseAmount((legacyApp as any)?.equipmentAmount) ??
            bfParseAmount((legacyApp as any)?.kyc?.equipmentAmount) ??
            null;
          if (equipmentAmount && equipmentAmount > 0) {
            // BF_SERVER_BLOCK_v126a_CAPITAL_EQUIPMENT_FIXES_v1 — idempotency.
            // Re-submit (network retry, tab reload + resubmit) previously
            // created duplicate equipment legs because no existence check
            // ran before INSERT. Mirrors v125a closing-costs idempotency.
            const existingLeg = await pool.query<{ id: string }>(
              `SELECT id FROM applications
                WHERE parent_application_id::text = ($1)::text
                  AND (
                    source = 'capital_and_equipment_leg'
                    OR metadata->>'capital_and_equipment_leg' = 'true'
                    OR metadata->>'leg_category' = 'EQUIPMENT'
                  )
                LIMIT 1`,
              [application.id]
            );
            if (existingLeg.rows.length > 0) {
              // BF_SERVER_BLOCK_v127a_COMPANION_METADATA_BACKFILL_v1
              // C&E equipment legs created at Step 2 (theoretical; today
              // they only come from submit-time fan-out) would have thin
              // metadata. Same back-fill pattern as the closing-costs
              // case. The submitted_at marker ensures we only back-fill
              // once. No-op on first submit since the leg was just
              // INSERTed with full metaPatch already.
              try {
                const existingId = existingLeg.rows[0].id;
                await pool.query(
                  `UPDATE applications
                      SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                          updated_at = now()
                    WHERE id::text = ($2)::text
                      AND COALESCE(metadata->>'_v127a_backfilled', '') <> 'true'`,
                  [
                    JSON.stringify({ ...metaPatch, _v127a_backfilled: "true" }),
                    existingId,
                  ]
                );
                logInfo("capital_and_equipment_leg_metadata_backfilled", {
                  parentApplicationId: application.id,
                  legApplicationId: existingId,
                });
              } catch (backfillErr) {
                logError("capital_and_equipment_leg_backfill_failed", {
                  code: "capital_and_equipment_leg_backfill_failed",
                  parentApplicationId: application.id,
                  error: backfillErr instanceof Error ? backfillErr.message : "unknown",
                });
              }
              logInfo("capital_and_equipment_leg_already_exists", {
                parentApplicationId: application.id,
                existingLegId: existingLeg.rows[0].id,
                source: "submit_skipped_duplicate",
              });
            } else {
              const equipmentId = randomUUID();
              await pool.query(
                `INSERT INTO applications
                   (id, name, silo, owner_user_id, parent_application_id,
                    requested_amount, product_category, pipeline_state, status,
                    lender_id, lender_product_id, source, metadata, submitted_at, created_at, updated_at)
                 VALUES
                   ($1, $2, $3, $4, $5,
                    $6, 'EQUIPMENT', 'Received', $10,
                    $7, $8, 'capital_and_equipment_leg',
                    jsonb_build_object('capital_and_equipment_leg', true,
                                       'parent_application_id', $5::text,
                                       'leg_category', 'EQUIPMENT') || $9::jsonb,
                    now(), now(), now())`,
                [
                  equipmentId,
                  `Equipment leg — ${wizardBusinessName ?? application.id.slice(0, 8)}`,
                  silo,
                  ownerId,
                  application.id,
                  equipmentAmount,
                  null,
                  null,
                  JSON.stringify(metaPatch),
                  statusFromPipeline(ApplicationStage.RECEIVED),
                ]
              );
              v330_equipmentLegId = equipmentId;
              v330_equipmentLegAmount = equipmentAmount;
              logInfo("capital_and_equipment_leg_created", {
                parentApplicationId: application.id,
                equipmentApplicationId: equipmentId,
                equipmentAmount,
              });
            }
          } else {
            logError("capital_and_equipment_leg_missing_amount", {
              code: "capital_and_equipment_leg_missing_amount",
              parentApplicationId: application.id,
            });
          }
        }
      } catch (fanOutErr) {
        logError("capital_and_equipment_leg_failed", {
          code: "capital_and_equipment_leg_failed",
          parentApplicationId: application.id,
          error: fanOutErr instanceof Error ? fanOutErr.message : "unknown",
        });
      }
      // BF_SERVER_BLOCK_v81_CLOSING_COSTS_COMPANION — companion app for closing
      // costs.
      const wantsClosingCosts = Boolean(
        (legacyApp as any)?.requires_closing_cost_funding ??
        (legacyApp as any)?.requiresClosingCostFunding
      );
      const primaryCategory = String(
        (legacyApp as any)?.productCategory ??
        (legacyApp as any)?.product_category ??
        ""
      ).toUpperCase();
      // BF_SERVER_BLOCK_v85_MULTI_LEG_SUBMIT_v1
      // Companion only fires for pure-Equipment parents (Capital&Equipment
      // users have no companion — their capital leg serves the same role).
      // Companion category is amount-based: TERM ≤ $50k, else LOC.
      const EQUIPMENT_PARENT_ALIASES = new Set([
        "EQUIPMENT", "EQUIPMENT_FINANCE", "EQUIPMENT_FINANCING",
      ]);
      if (wantsClosingCosts && EQUIPMENT_PARENT_ALIASES.has(primaryCategory)) {
        try {
          // BF_SERVER_BLOCK_v125a_CLOSING_COSTS_END_TO_END_v1 — idempotency.
          // If Step 2 already created a companion (now possible after
          // v125a fixes the schema/response), do not create a duplicate.
          const existingCompanion = await pool.query<{ id: string }>(
            `SELECT id FROM applications
              WHERE parent_application_id::text = ($1)::text
                AND (
                  source = 'closing_costs_companion'
                  OR metadata->>'closing_cost_companion' = 'true'
                  OR metadata->>'kind' = 'closing_costs'
                )
              LIMIT 1`,
            [application.id]
          );
          if (existingCompanion.rows.length > 0) {
            // BF_SERVER_BLOCK_v127a_COMPANION_METADATA_BACKFILL_v1
            // The Step 2 closing-costs companion was created with only
            // KYC data (Steps 3+4 weren't filled yet at that point).
            // Submit-time skip preserves uniqueness but leaves the
            // companion's metadata thin. Merge parent's wizard payload
            // (formData, business, applicant, etc.) into the existing
            // companion so its drawer Application tab renders properly.
            // The submitted_at marker ensures we only back-fill once.
            try {
              const existingId = existingCompanion.rows[0].id;
              await pool.query(
                `UPDATE applications
                    SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                        updated_at = now()
                  WHERE id::text = ($2)::text
                    AND COALESCE(metadata->>'_v127a_backfilled', '') <> 'true'`,
                [
                  JSON.stringify({ ...metaPatch, _v127a_backfilled: "true" }),
                  existingId,
                ]
              );
              logInfo("closing_costs_companion_metadata_backfilled", {
                parentApplicationId: application.id,
                companionApplicationId: existingId,
              });
            } catch (backfillErr) {
              logError("closing_costs_companion_backfill_failed", {
                code: "closing_costs_companion_backfill_failed",
                parentApplicationId: application.id,
                error: backfillErr instanceof Error ? backfillErr.message : "unknown",
              });
            }
            logInfo("closing_costs_companion_already_exists", {
              parentApplicationId: application.id,
              existingCompanionId: existingCompanion.rows[0].id,
              source: "submit_skipped_duplicate",
            });
          } else {
            const primaryAmount = Number(wizardCols.requestedAmount ?? 0);
            const companionAmount = Math.round(primaryAmount * 0.2);
            const companionCategory = companionAmount <= 50_000 ? "TERM" : "LOC";
            const companionId = randomUUID();
            // BF_SERVER_BLOCK_v125a_CLOSING_COSTS_END_TO_END_v1 — copy parent
            // wizard payload into companion metadata so the companion's
            // drawer Application tab renders properly (otherwise it shows
            // mostly empty: just id/stage/source).
            const companionMeta: Record<string, unknown> = {
              ...wizardMeta,
              formData: legacyApp,
              closing_cost_companion: true,
              parent_application_id: application.id,
              companion_category: companionCategory,
              kind: "closing_costs",
              linked_application_reason: "closing_costs",
              companion_origin: "submit_fallback",
            };
            await pool.query(
              `INSERT INTO applications
                 (id, name, silo, owner_user_id, parent_application_id,
                  requested_amount, product_category, pipeline_state, status,
                  lender_id, lender_product_id, source, metadata, submitted_at, created_at, updated_at)
               VALUES
                 ($1, $2, $3, $4, $5,
                  $6, $7, 'Received', 'received',
                  $8, $9, 'closing_costs_companion',
                  $10::jsonb,
                  now(), now(), now())`,
              [
                companionId,
                `Closing costs — ${wizardBusinessName ?? application.id.slice(0, 8)}`,
                silo,
                ownerId,
                application.id,
                companionAmount > 0 ? companionAmount : null,
                companionCategory,
                null,
                null,
                JSON.stringify(companionMeta),
              ]
            );
            v330_companionLegId = companionId;
            v330_companionLegAmount = companionAmount;
            logInfo("closing_costs_companion_created", {
              parentApplicationId: application.id,
              companionApplicationId: companionId,
              category: companionCategory,
              amount: companionAmount,
            });
          }
        } catch (companionErr) {
          logError("closing_costs_companion_failed", {
            code: "closing_costs_companion_failed",
            parentApplicationId: application.id,
            error: companionErr instanceof Error ? companionErr.message : "unknown",
          });
        }
      } else if (!wantsClosingCosts && EQUIPMENT_PARENT_ALIASES.has(primaryCategory)) {
        // BF_SERVER_BLOCK_v197_CLOSING_COSTS_COMPANION_CLEANUP_v1
        // User toggled closing-costs OFF after a Step-2 modal-flow companion
        // was created (BLOCK_v125a path). Without this, the orphaned companion
        // sits in the pipeline at pipeline_state='Received'. We mirror the
        // same idempotent detection query used above and soft-delete by
        // setting pipeline_state='Archived' rather than DELETE, so any audit
        // links remain valid. Staff with "Show drafts" off will not see the
        // archived companion. Wrapped in try/catch so cleanup failure never
        // blocks the parent submit.
        try {
          const orphan = await pool.query<{ id: string }>(
            `SELECT id FROM applications
              WHERE parent_application_id::text = ($1)::text
                AND (
                  source = 'closing_costs_companion'
                  OR metadata->>'closing_cost_companion' = 'true'
                  OR metadata->>'kind' = 'closing_costs'
                )
                AND pipeline_state IS DISTINCT FROM 'Archived'
              LIMIT 1`,
            [application.id]
          );
          if (orphan.rows.length > 0) {
            const orphanId = orphan.rows[0].id;
            await pool.query(
              `UPDATE applications
                  SET pipeline_state = 'Archived',
                      metadata = COALESCE(metadata, '{}'::jsonb)
                                 || jsonb_build_object(
                                      'archived_reason', 'closing_costs_toggled_off',
                                      'archived_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                                    ),
                      updated_at = now()
                WHERE id::text = ($1)::text`,
              [orphanId]
            );
            logInfo("closing_costs_companion_archived", {
              parentApplicationId: application.id,
              companionApplicationId: orphanId,
              reason: "user_toggled_off",
            });
          }
        } catch (cleanupErr) {
          logError("closing_costs_companion_cleanup_failed", {
            code: "closing_costs_companion_cleanup_failed",
            parentApplicationId: application.id,
            error: cleanupErr instanceof Error ? cleanupErr.message : "unknown",
          });
        }
      }
      if (primaryCategory) {
        try {
          await pool.query(
            `UPDATE applications SET product_category = $1 WHERE id = $2`,
            [primaryCategory, application.id]
          );
        } catch {}
      }

      // BF_APP_TO_CRM_v38 — Block 38-E — fire-and-forget CRM mirror.
      try {
        const md: any = (legacyApp && typeof legacyApp === "object") ? legacyApp : {};
        void mirrorApplicationToCrm({
          applicationId: application.id,
          silo: (silo || "BF").toUpperCase(),
          business: md?.business ?? md?.company ?? null,
          applicant: md?.applicant ?? md?.borrower ?? null,
          // BF_SERVER_CRM_MIRROR_OTP_PHONE_AUTHORITATIVE_v1 — the signed-in
          // applicant's OTP-verified phone is authoritative for their contact.
          verifiedPhone: (req as any)?.user?.phone ?? null,
        });
      } catch { /* never block submit on mirror */ }

      // BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1
      // If the applicant opted into PGI on Step 6, hand off to
      // BI-Server. Synchronous (not fire-and-forget) so the response
      // includes the completion URL and the mini-portal messenger
      // can show the link immediately. Bounded to 8s by biHandoff.
      // Failure here is non-fatal — BF submit still succeeds and
      // staff can re-trigger the handoff from the portal later.
      try {
        const pgiOptIn = String((legacyApp as any)?.pgi_opt_in ?? "").toLowerCase();
        if (pgiOptIn === "yes") {
          // BF_SERVER_BLOCK_v330_MULTI_APP_PGI_HANDOFF_v1
          // One PGI policy per funding/equipment application:
          //   - primary (always)
          //   - equipment leg (when scenario 4 fired)
          //   - closing-costs companion (when scenario 3 fired)
          const v330_handoffTargets: Array<{
            bfApplicationId: string;
            loanAmountOverride: number | null;
            role: "primary" | "equipment_leg" | "closing_costs_companion";
          }> = [
            { bfApplicationId: application.id, loanAmountOverride: null, role: "primary" },
          ];
          if (v330_equipmentLegId != null) {
            v330_handoffTargets.push({
              bfApplicationId: v330_equipmentLegId,
              loanAmountOverride: v330_equipmentLegAmount,
              role: "equipment_leg",
            });
          }
          if (v330_companionLegId != null) {
            v330_handoffTargets.push({
              bfApplicationId: v330_companionLegId,
              loanAmountOverride: v330_companionLegAmount,
              role: "closing_costs_companion",
            });
          }

          for (const v330_t of v330_handoffTargets) {
            const r = await postBiHandoff({
              bfApplicationId: v330_t.bfApplicationId,
              legacyApp,
              loanAmountOverride: v330_t.loanAmountOverride,
            });
            if (r.ok) {
              await pool.query(
                `UPDATE applications
                    SET bi_application_id = $1,
                        bi_public_id = $2,
                        bi_completion_url = $3,
                        updated_at = NOW()
                  WHERE id::text = ($4)::text`,
                [r.biApplicationId, r.biPublicId, r.completionUrl, v330_t.bfApplicationId],
              );
              // v330: one messenger message per funding app's PGI policy.
              // The body names the product category when available so the
              // applicant can tell which policy belongs to which application.
              const v330_roleLabel = v330_t.role === "primary"
                ? "main funding"
                : v330_t.role === "equipment_leg"
                  ? "equipment"
                  : "closing costs";
              // BF_SERVER_BLOCK_v777_PGI_PRODUCT_LABEL — name the PGI message after
              // the BF app's product category (LOC / Equipment / …) instead of the
              // generic funding-leg role, so a client with several apps can tell
              // which policy belongs to which application.
              const v777_catRow = await pool.query<{ product_category: string | null; product_type: string | null }>(
                `SELECT product_category, product_type FROM applications WHERE id::text = ($1)::text LIMIT 1`,
                [v330_t.bfApplicationId],
              );
              const v777_label = (() => {
                const raw = String(v777_catRow.rows[0]?.product_category ?? v777_catRow.rows[0]?.product_type ?? "").trim();
                if (!raw) return v330_roleLabel;
                const k = raw.toLowerCase().replace(/[\s-]+/g, "_");
                const m: Record<string, string> = { line_of_credit: "LOC", loc: "LOC", equipment_financing: "Equipment", equipment: "Equipment", equipment_finance: "Equipment", working_capital: "Working Capital", term_loan: "Term Loan", factoring: "Factoring" };
                return m[k] ?? raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
              })();
              try {
                const v650_existingMsg = await pool.query<{ id: string }>(
                  `SELECT id FROM communications_messages
                    WHERE application_id = $1
                      AND staff_name = 'Boreal Insurance'
                      AND body LIKE $2
                    LIMIT 1`,
                  [v330_t.bfApplicationId, `%${r.completionUrl}%`]
                );
                if (v650_existingMsg.rows.length === 0) {
                  await pool.query(
                    `INSERT INTO communications_messages
                       (id, type, direction, status, application_id, contact_id, silo, body, staff_name, cta_label, cta_action, created_at)
                     VALUES (
                       $1, 'message', 'outbound', 'sent', $2,
                       (SELECT contact_id FROM applications WHERE id = $2 LIMIT 1),
                       COALESCE((SELECT silo FROM applications WHERE id = $2 LIMIT 1), 'BF'),
                       $3, 'Boreal Insurance', $4, $5, NOW()
                     )`,
                    [
                      biRandomUUID(),
                      v330_t.bfApplicationId,
                      `Your PGI application for the ${v777_label} funding portion is ready to complete.`,
                      "Complete PGI Application",
                      r.completionUrl,
                    ],
                  );
                }
              } catch (msgErr) {
                logError("bi_handoff_messenger_insert_failed", {
                  code: "bi_handoff_messenger_insert_failed",
                  applicationId: v330_t.bfApplicationId,
                  role: v330_t.role,
                  error: msgErr instanceof Error ? msgErr.message : "unknown",
                });
              }
              try {
                const v650_contactRes = await pool.query<{ phone: string | null }>(
                  `SELECT c.phone
                     FROM applications a
                LEFT JOIN contacts c ON c.id = a.contact_id
                    WHERE a.id = $1
                    LIMIT 1`,
                  [v330_t.bfApplicationId]
                );
                const phoneFromContact = v650_contactRes.rows[0]?.phone ?? null;
                const phoneFromMeta = (() => {
                  try {
                    const md = (application as any).metadata ?? {};
                    const fd = md.formData ?? {};
                    return fd?.applicant?.phone ?? md?.applicant?.phone ?? md?.borrower?.phone ?? null;
                  } catch { return null; }
                })();
                const v650_to = String(phoneFromContact ?? phoneFromMeta ?? "").trim();
                if (v650_to) {
                  const { sendSms } = await import("../../modules/notifications/sms.service.js");
                  await sendSms({
                    to: v650_to,
                    message: `Boreal Insurance: your PGI application for the ${v777_label} funding portion is ready to complete: ${r.completionUrl}`,
                  }).catch((smsErr) => {
                    logError("bi_handoff_sms_failed_nonfatal", {
                      code: "bi_handoff_sms_failed_nonfatal",
                      applicationId: v330_t.bfApplicationId,
                      role: v330_t.role,
                      error: smsErr instanceof Error ? smsErr.message : "unknown",
                    });
                  });
                }
              } catch (smsOuterErr) {
                logError("bi_handoff_sms_unexpected", {
                  code: "bi_handoff_sms_unexpected",
                  applicationId: v330_t.bfApplicationId,
                  error: smsOuterErr instanceof Error ? smsOuterErr.message : "unknown",
                });
              }
              logInfo("bi_handoff_recorded", {
                applicationId: v330_t.bfApplicationId,
                role: v330_t.role,
                biPublicId: r.biPublicId,
              });
            } else {
              logError("bi_handoff_failed_nonfatal", {
                code: "bi_handoff_failed_nonfatal",
                applicationId: v330_t.bfApplicationId,
                role: v330_t.role,
                error: r.error,
              });
            }
          }
        }
      } catch (handoffErr) {
        logError("bi_handoff_unexpected", {
          code: "bi_handoff_unexpected",
          applicationId: application.id,
          error: handoffErr instanceof Error ? handoffErr.message : "unknown",
        });
      }
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

      // BF_SERVER_BLOCK_v780_APPLY_MATCH — match an existing contact by email OR
      // phone (the helper already does both); previously a phone-only applicant
      // with no email fell through to createContact and made a duplicate.
      const { row: applicant } = (applicantInput.email || applicantInput.phone)
        ? await findOrCreateContactByEmailAndCompany(tx, applicantInput.email ?? "", company.id, silo, applicantInput)
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
        const result = (partnerInput.email || partnerInput.phone)
          ? await findOrCreateContactByEmailAndCompany(tx, partnerInput.email ?? "", company.id, silo, partnerInput)
          : { row: await createContact(tx, partnerInput) };
        partner = result.row;
      }

      await linkContactToApplication(tx, application.id, applicant.id, "applicant");
      if (partner) {
        await linkContactToApplication(tx, application.id, partner.id, "partner");
      }

      // Set the application's primary contact so downstream reads (conversation
      // names, CRM People panel, "contact linked" checks) resolve a real person
      // instead of falling back to the application UUID. Only set when unset.
      await tx.query(
        "UPDATE applications SET contact_id = $1 WHERE id::text = ($2)::text AND contact_id IS NULL",
        [applicant.id, application.id]
      );

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
  safeHandler(async (req: any, res: any) => {
    const applicationId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const application = await findApplicationById(applicationId);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }

    // Hydrate the wizard shape the BF-client resume.ts expects. The metadata
    // jsonb column carries everything the wizard PATCHed in steps 1-4; the
    // documents map is rebuilt from the documents table so an upload made
    // from another tab/device shows up immediately on reload.
    const meta: any = (application as any).metadata ?? {};
    const formData: any = meta?.formData ?? {};

    const docRows = await listDocumentsByApplicationId(applicationId).catch(() => []);
    const documents: Record<string, any> = {};
    for (const row of docRows) {
      const key = row.document_type || (row as any).category;
      if (!key) continue;
      // Top-level fields are last-write-wins (status/gate compat); files[] keeps
      // EVERY uploaded document of this type so the wizard lists all of them
      // (e.g. 6 bank statements) on reload, not just the most recent.
      const prevFiles = (documents[key]?.files as Array<any> | undefined) ?? [];
      documents[key] = {
        id: row.id,
        name: row.filename ?? null,
        status: row.status,
        rejectionReason: (row as any).rejection_reason ?? null,
        uploadedAt: row.created_at,
        files: [
          ...prevFiles,
          { id: row.id, name: row.filename ?? null, uploadedAt: row.created_at },
        ],
      };
    }

    res.status(200).json({
      status: {
        applicationId: application.id,
        pipelineState: (application as any).pipeline_state ?? null,
        processingStage: (application as any).processing_stage ?? null,
        updatedAt: application.updated_at,

        // BF_SERVER_BLOCK_STATUS_HYDRATION_v80 — full wizard rehydration.
        business: meta.business ?? formData.business ?? null,
        applicant: meta.applicant ?? formData.applicant ?? null,
        partner: meta.partner ?? formData.partner ?? null,
        kyc: meta.kyc ?? formData.kyc ?? formData.financialProfile ?? null,
        financialProfile: formData.financialProfile ?? meta.kyc ?? null,
        productCategory:
          meta.product_category ??
          formData.productCategory ??
          formData.product_category ??
          null,
        selectedProduct: meta.selected_product ?? formData.selectedProduct ?? null,
        selectedProductId:
          formData.selectedProductId ?? formData.selected_product_id ?? null,
        selectedProductType:
          meta.selected_product_type ??
          formData.selectedProductType ??
          formData.selected_product_type ??
          null,
        // BF_SERVER_BLOCK_v82_DEFER_PERSIST — read from either path; PATCH
        // writes to meta.documentsDeferred, submit writes to meta.formData.
        documentsDeferred:
          meta.documentsDeferred ??
          formData.documentsDeferred ??
          false,
        documents,
        documentReviewComplete: formData.documentReviewComplete ?? null,
        financialReviewComplete: formData.financialReviewComplete ?? null,
        currentStep: formData.currentStep ?? null,
        termsAccepted: formData.termsAccepted ?? false,
        typedSignature: formData.typedSignature ?? null,
        coApplicantSignature: formData.coApplicantSignature ?? null,
        signatureDate: formData.signatureDate ?? null,
        requires_closing_cost_funding: formData.requires_closing_cost_funding ?? false,
      },
    });
  })
);

// v615: phone-keyed lookup so post-OTP can route to the mini-portal.
router.get(
  "/applications/by-phone",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    // BF_SERVER_BLOCK_v727_MULTI_APP_BY_PHONE_v1 — return ALL of the caller's
    // applications (multi-application switcher), matched by last-10 phone digits
    // so format differences don't drop one. Includes product_category + amount +
    // stage for the switcher labels. `application` (first/most-recent) is kept for
    // backward compatibility with single-app callers.
    const phoneRaw = String(req.user?.phone ?? "").trim();
    const phone10 = phoneRaw.replace(/[^0-9]/g, "").slice(-10);
    if (!phone10) return res.status(401).json({ found: false, error: "no_phone_claim" });

    // BF_SERVER_BLOCK_v765_BY_PHONE_INCLUDE_DRAFTS — the switcher opts in to
    // drafts via ?includeDrafts=true. Default (OTP routing) still excludes them
    // so a draft-only caller resumes the wizard instead of routing to a portal.
    const includeDrafts = String(req.query?.includeDrafts ?? "") === "true";
    const draftFilter = includeDrafts
      ? "AND a.pipeline_state IS NOT NULL AND a.pipeline_state <> ''"
      : "AND a.pipeline_state NOT IN ('draft','Draft','') AND a.pipeline_state IS NOT NULL";

    const r = await pool.query(
      `SELECT a.id, a.pipeline_state, a.submitted_at, a.name AS business_name,
              a.product_category, a.requested_amount, a.updated_at
         FROM applications a
         JOIN contacts c ON c.id = a.contact_id -- v342_FIX_CRM_CONTACTS
        WHERE right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
          ${draftFilter}
        ORDER BY a.updated_at DESC`,
      [phone10],
    );

    // de-dupe by application id (a phone can appear on multiple contact-linked rows)
    const seen = new Set<string>();
    const applications = [] as any[];
    for (const row of r.rows) {
      const id = String((row as any).id);
      if (seen.has(id)) continue;
      seen.add(id);
      applications.push(row);
    }

    if (!applications.length) return res.json({ found: false, applications: [] });
    return res.json({ found: true, applications, application: applications[0] });
  }),
);

export default router;
