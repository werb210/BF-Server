import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { fetchStatus as startupStatus, isReady } from "../startupState.js";
import { pool, runQuery } from "../db.js";
import {
  findActiveDocumentVersion,
  findApplicationById,
  listDocumentsByApplicationId,
} from "../modules/applications/applications.repo.js";
// BF_SERVER_BLOCK_v202_PORTAL_FINANCIALS_ENDPOINT_v1
import { listOcrFieldsForApplication } from "../modules/ocr/ocr.repo.js";
import { OCR_FIELD_REGISTRY } from "../modules/ocr/ocrFieldRegistry.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";
import { PIPELINE_STATES as PIPELINE_STAGES } from "../modules/applications/pipelineState.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { listApplicationStages } from "../controllers/applications.controller.js";
import { portalRateLimit } from "../middleware/rateLimit.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { AppError } from "../middleware/errors.js";
import { getSilo } from "../middleware/silo.js";
import { isPipelineState } from "../modules/applications/pipelineState.js";
import { transitionPipelineState, openApplicationForStaff } from "../modules/applications/applications.service.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { advanceProcessingStage } from "../modules/applications/processingStage.service.js";
import {
  retryProcessingJob,
  retryProcessingJobForApplication,
} from "../modules/processing/retry.service.js";
import {
  assertPipelineState,
  assertPipelineTransition,
  resolveNextPipelineStage,
} from "../modules/applications/applicationLifecycle.service.js";
import { config } from "../config/index.js";
import { listLenders } from "../repositories/lenders.repo.js";
import { eventBus } from "../events/eventBus.js";
// BF_AZURE_OCR_TERMSHEET_v44 — term sheet upload deps
import multer from "multer";
import { getStorage } from "../lib/storage/index.js";
import { sendSMS } from "../services/smsService.js";
import { toStringSafe } from "../utils/toStringSafe.js";
import twilio from "twilio";
import { progressSubmission } from "../services/submission/orchestrator.js";
// BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
import { computeAndCacheLenderMatches, markLenderMatchesStale, getOutstandingRequiredDocs } from "../services/lenderMatchCache.js";
// BF_APP_ID_CAST_v39 — Block 39-A — applications.id comparisons cast to text

const router = Router();
const portalLimiter = portalRateLimit();

function ensureReady(res: Response): boolean {
  if (!isReady()) {
    const status = startupStatus();
    res.status(503).json({
      ok: false,
      code: "service_not_ready",
      reason: status.reason,
    });
    return false;
  }
  return true;
}

function ensureAuditHistoryEnabled(): void {
  if (!config.flags.auditHistoryEnabled) {
    throw new AppError("not_found", "Audit history is disabled.", 404);
  }
}

function parsePagination(query: Request["query"]): { limit: number; offset: number } {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : NaN;
  const offsetRaw = typeof query.offset === "string" ? Number(query.offset) : NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

// ── Pipeline helpers ──────────────────────────────────────────────────────────
async function recordTransition(
  appId: string,
  fromStage: string,
  toStage: string,
  actorId: string | null,
  reason: string
): Promise<void> {
  await runQuery(
    `INSERT INTO application_stage_events
       (application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at)
     VALUES ($1, $2, $3, 'auto', $4, $5, now())`,
    [appId, fromStage, toStage, actorId ?? "system", reason]
  ).catch(() => {});
}

async function allDocumentsAccepted(appId: string): Promise<boolean> {
  const result = await runQuery<{ total: string; accepted: string }>(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE status = 'accepted') AS accepted
     FROM documents
     WHERE application_id = $1 AND status != 'rejected'`,
    [appId]
  ).catch(() => null);
  if (!result?.rows[0]) return false;
  const { total, accepted } = result.rows[0];
  return parseInt(total) > 0 && total === accepted;
}

// ── Document reject — auto-SMS ────────────────────────────────────────────
async function sendDocumentRejectionSms(params: {
  documentId: string;
  documentType: string;
  applicationId: string;
  rejectionReason: string | null;
}): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !from) return;

  // Find the contact phone via application → owner
  const result = await pool.query<{ phone: string | null; phone_number: string | null }>(
    `SELECT u.phone_number AS phone_number, c.phone AS phone
     FROM applications a
     LEFT JOIN users u ON u.id = a.owner_user_id
     LEFT JOIN contacts c ON c.id = a.contact_id
     WHERE a.id::text = ($1)::text LIMIT 1`,
    [params.applicationId]
  ).catch(() => ({ rows: [] }));

  const row = result.rows[0];
  const to = row?.phone ?? row?.phone_number;
  if (!to) return;

  const reason = params.rejectionReason ? ` Reason: ${params.rejectionReason}.` : "";
  const body =
    `Your document "${params.documentType}" has been rejected.${reason} ` +
    "Please log in to re-upload: https://client.boreal.financial";

  const client: any = twilio(accountSid, authToken);
  const msg = await client.messages.create({ body, from, to }).catch(() => null);
  if (msg) {
    await pool.query(
      `INSERT INTO communications_messages
         (id, type, direction, status, body, phone_number, from_number, to_number, twilio_sid, application_id, created_at)
       VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, now())`,
      [msg.status, body, to, from, msg.sid, params.applicationId]
    ).catch(() => {});
  }
}

router.get(
  "/applications",
  // BF_SERVER_BLOCK_1_32_BACKLOG_CLEANUP
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    if (!ensureReady(res)) {
      return;
    }
    try {
      // BF_SERVER_BLOCK_v81_PIPELINE_HYDRATION — full card data, including drafts.
      // BF_SERVER_BLOCK_v101_INCLUDE_DRAFTS_PARAM_v1
      // BF-portal PipelinePage sends ?include_drafts=1 (boolean-as-int).
      // Accept that as well as the older ?showDrafts=true / ?show_drafts.
      // Without this, the staff "Show drafts" toggle was silently a no-op
      // and drafts never appeared regardless of state.
      const truthy = (v: unknown) => {
        const s = String(v ?? "").trim().toLowerCase();
        return s === "1" || s === "true" || s === "yes";
      };
      const showDrafts =
        truthy(req.query.showDrafts) ||
        truthy(req.query.show_drafts) ||
        truthy(req.query.include_drafts) ||
        truthy(req.query.includeDrafts);
      // BF_SERVER_BLOCK_v120_PORTAL_APPLICATIONS_SILO_FROM_RESOLVED_v1
      // Read silo from the resolved middleware value (X-Silo header for
      // multi-silo users, primary silo for single-silo users) instead of
      // ONLY from query string. PipelinePage.tsx and core fetchPipeline
      // both call /api/portal/applications without setting a query silo
      // param, so the previous string read collapsed to "BF" and BI/SLF
      // staff saw an empty pipeline. Query param remains supported for
      // explicit overrides (e.g. admin viewing another silo).
      const { getSilo } = await import("../middleware/silo.js");
      const businessUnit = String(
        req.query.business_unit ??
        req.query.silo ??
        getSilo(res) ??
        "BF"
      ).toUpperCase();
      const where: string[] = ["a.silo = $1"];
      const values: unknown[] = [businessUnit];
      if (!showDrafts) {
        where.push(`COALESCE(a.pipeline_state, '') NOT IN ('draft','Draft','')`);
      }
      // BF_SERVER_BLOCK_v86_PARENT_APPLICATION_ID_FILTER_v1
      // Optional filter: ?parent_application_id=<uuid> returns only
      // applications whose parent_application_id matches the given id.
      // Used by BF-portal v93 linked-chip drawer feature.
      const parentIdRaw = String(req.query.parent_application_id ?? req.query.parentApplicationId ?? "").trim();
      const APP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (parentIdRaw && APP_UUID_RE.test(parentIdRaw)) {
        values.push(parentIdRaw);
        where.push(`a.parent_application_id::text = $${values.length}::text`);
      }
      // BF_SERVER_BLOCK_v131_PIPELINE_SQL_REPAIR_v1
      // Replace the bogus `a.primary_contact_id` JOIN — that column was
      // never added by any migration. The whole query was throwing
      // "column does not exist", the catch below was swallowing it,
      // and the pipeline rendered empty for 86 production rows.
      // Use application_contacts (role='applicant') the way auth.ts
      // already does. LEFT JOIN ... LATERAL LIMIT 1 keeps it 1:1 even
      // if a future bug ever inserts duplicate applicant rows.
      const sql = `
        SELECT
          a.id,
          a.pipeline_state                                      AS stage,
          a.requested_amount                                    AS requested_amount,
          a.product_category                                    AS product_category,
          a.parent_application_id                               AS parent_application_id,
          COALESCE(a.pipeline_state IN ('draft','Draft',''),false) AS is_draft,
          COALESCE(NULLIF(a.name, ''), c.name, 'Unnamed application') AS business_name,
          ct.name                                               AS contact_name,
          ct.email                                              AS contact_email,
          u.first_name || ' ' || u.last_name                    AS owner_name,
          a.updated_at                                          AS last_activity_at,
          COALESCE(a.metadata->>'status_note', '')              AS status_note
        FROM applications a
        LEFT JOIN companies c ON c.id = a.company_id
        LEFT JOIN LATERAL (
          SELECT contact_id
            FROM application_contacts
           WHERE application_id = a.id AND role = 'applicant'
           ORDER BY created_at ASC
           LIMIT 1
        ) ac ON true
        LEFT JOIN contacts ct ON ct.id = ac.contact_id
        LEFT JOIN users u    ON u.id = a.owner_user_id
        WHERE ${where.join(" AND ")}
        ORDER BY a.updated_at DESC
        LIMIT 500
      `;
      const result = await runQuery(sql, values);
      // BF_SERVER_BLOCK_v120_PORTAL_APPLICATIONS_SILO_FROM_RESOLVED_v1
      // Emit BOTH shapes so both PipelinePage variants render. The legacy
      // /pages/pipeline/PipelinePage.tsx destructures `items`; the newer
      // /core/engines/pipeline/pipeline.api.ts goes through
      // parsePipelineResponse which reads `applications`. Returning both
      // is cheap and unbreaks the BF pipeline view immediately.
      const cards = result.rows.map((r: any) => ({
        id: r.id,
        // Legacy PipelinePage shape (snake_case, reads pipeline_state directly):
        name: r.business_name,
        business_legal_name: r.business_name,
        pipeline_state: r.stage,
        requested_amount: r.requested_amount,
        created_at: r.last_activity_at,
        // Modern shape used by parsePipelineResponse (camelCase):
        stage: r.stage ?? "draft",
        requestedAmount: r.requested_amount,
        productCategory: r.product_category,
        businessName: r.business_name,
        contactName: r.contact_name,
        contactEmail: r.contact_email,
        ownerName: r.owner_name,
        lastActivityAt: r.last_activity_at,
        statusNote: r.status_note,
        parentApplicationId: r.parent_application_id,
        isDraft: r.is_draft,
      }));
      return res.json({
        stages: PIPELINE_STAGES,
        applications: cards,
        items: cards,
      });
    } catch (err) {
      // BF_SERVER_BLOCK_v131_PIPELINE_SQL_REPAIR_v1 — surface the
      // underlying error so the next schema drift is loud, not silent.
      // Still return 200 with empty list so the UI doesn't break for
      // users; staff can read the cause from the structured log.
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.code ?? null;
      // eslint-disable-next-line no-console
      console.error("[portal.applications.query_failed]", { code, message });
      res.status(200).json({ stages: PIPELINE_STAGES, applications: [], items: [], _error: { code, message } });
    }
  })
);

router.get(
  "/applications/stages",
  portalLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    if (!ensureReady(res)) {
      return;
    }
    await listApplicationStages(req, res);
  })
);

router.get(
  "/applications/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: Response) => {
    if (!ensureReady(res)) {
      return;
    }
    const applicationId = toStringSafe(req.params.id);
    if (!applicationId) throw new AppError("validation_error", "Application id required.", 400);

    const stageResult = await runQuery<{ pipeline_state: string; silo: string | null }>(
      `SELECT pipeline_state, silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    // BF_SERVER_BLOCK_v309_PORTAL_SILO_ENFORCEMENT_v1
    // The detail endpoint previously returned full applicant metadata for
    // any application by id, regardless of the caller's silo context. The
    // /applications list endpoint (line 152) already filters by silo, but
    // a staff member could still hit /applications/<other-silo-uuid>
    // directly and receive the record. 404 (not 403) to avoid leaking
    // existence in another silo. Pattern mirrors the canonical guard in
    // src/modules/applications/applications.routes.ts.
    const callerSilo = getSilo(res);
    const recordSilo = stageResult.rows[0]?.silo ?? null;
    if (recordSilo && callerSilo && recordSilo !== callerSilo) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    if (stageResult.rows[0]?.pipeline_state === "Received") {
      await runQuery(
        `UPDATE applications SET pipeline_state = 'In Review', updated_at = now() WHERE id::text = ($1)::text`,
        [applicationId]
      ).catch(() => {});
      await recordTransition(
        applicationId,
        "Received",
        "In Review",
        req.user?.userId ?? null,
        "Staff opened application"
      );
    }

    const record = await findApplicationById(applicationId);
    if (!record) {
      res.status(404).json({
        code: "not_found",
        message: "Application not found.",
        requestId: res.locals.requestId ?? "unknown",
      });
      return;
    }
    const documents = await listDocumentsByApplicationId(record.id);
    const documentsWithVersions = await Promise.all(
      documents.map(async (doc) => {
        const version = await findActiveDocumentVersion({ documentId: doc.id });
        const metadata =
          version && version.metadata && typeof version.metadata === "object"
            ? (version.metadata as {
                fileName?: string;
                mimeType?: string;
                size?: number;
                storageKey?: string;
              })
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
          // BF_SERVER_BLOCK_v199_DOC_STATUS_ON_PORTAL_DETAIL_v1
          // The portal DocumentsTab needs these for status pills + accept/reject UX.
          status: doc.status ?? null,
          rejectionReason: doc.rejection_reason ?? null,
          ocrStatus: doc.ocr_status ?? null,
        };
      })
    );
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
  })
);


// BF_SERVER_BLOCK_v202_PORTAL_FINANCIALS_ENDPOINT_v1
// Returns financial-category documents + their OCR-extracted fields with
// display labels resolved from OCR_FIELD_REGISTRY. Banking docs are
// filtered OUT — those go to the Banking Analysis tab via /api/banking.
//
// Doc-type filter accepts the canonical types (tax_returns, financial_statements,
// income_statement, balance_sheet, cash_flow, p_l, profit_loss) and reasonable
// aliases. Field filter restricts to source_document_type in
// {income_statement, balance_sheet, cash_flow, taxes} per OcrDocumentCategory.
const FINANCIAL_DOC_TYPE_PATTERNS: RegExp[] = [
  /^tax/i,
  /financial_statement/i,
  /balance_sheet/i,
  /income_statement/i,
  /^p_?l$/i,
  /profit_?loss/i,
  /cash_?flow/i,
];
const FINANCIAL_OCR_SOURCE_TYPES = new Set([
  "income_statement",
  "balance_sheet",
  "cash_flow",
  "taxes",
]);
function isFinancialDocType(t: string | null | undefined): boolean {
  if (!t) return false;
  // Exclude bank statements explicitly (their type often contains "statement")
  if (/^bank/i.test(t) || /bank_statement/i.test(t)) return false;
  return FINANCIAL_DOC_TYPE_PATTERNS.some((re) => re.test(t));
}
const OCR_FIELD_LABEL_MAP: Map<string, string> = new Map(
  OCR_FIELD_REGISTRY.map((d) => [d.field_key, d.display_label])
);

router.get(
  "/applications/:id/financials",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const applicationId = String(req.params.id ?? "").trim();
    if (!applicationId) {
      throw new AppError("validation_error", "Application id required.", 400);
    }
    const silo = getSilo(res);
    const appRow = await runQuery<{ id: string; silo: string | null }>(
      `SELECT id, silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    const app = appRow.rows[0];
    if (!app) throw new AppError("not_found", "Application not found.", 404);
    if (app.silo && silo && app.silo !== silo) {
      throw new AppError("not_found", "Application not found.", 404);
    }

    const allDocs = await listDocumentsByApplicationId(applicationId);
    const financialDocs = allDocs.filter((d) => isFinancialDocType(d.document_type));
    const docIds = new Set(financialDocs.map((d) => d.id));

    const allFields = await listOcrFieldsForApplication(applicationId).catch(
      () => [] as Awaited<ReturnType<typeof listOcrFieldsForApplication>>
    );
    const financialFields = allFields.filter((f) => {
      if (docIds.has(f.document_id)) return true;
      const src = f.source_document_type ?? "";
      return FINANCIAL_OCR_SOURCE_TYPES.has(src);
    });

    res.status(200).json({
      documents: financialDocs.map((d) => ({
        documentId: d.id,
        category: d.document_type,
        filename: d.filename ?? d.title ?? null,
        status: d.status ?? null,
        ocrStatus: (d as { ocr_status?: string | null }).ocr_status ?? null,
        uploadedAt: d.created_at,
      })),
      fields: financialFields.map((f) => ({
        documentId: f.document_id,
        sourceDocumentType: f.source_document_type ?? null,
        fieldKey: f.field_key,
        displayLabel: OCR_FIELD_LABEL_MAP.get(f.field_key) ?? f.field_key,
        value: f.value,
        confidence: f.confidence,
      })),
    });
  })
);

// BF_SERVER_BLOCK_v135_PORTAL_DELETE_AND_READINESS_FALLBACK_v1 — (A)
// BF-portal's PipelinePage trash button calls
//   DELETE /api/portal/applications/:id
// but no route was ever mounted at that path — only DELETE
// /api/applications/:id (in modules/applications/applications.routes.ts).
// The portal call 404s and the user sees "Delete failed". Mirror the
// admin-only delete here under the portal namespace so the existing
// portal admin auth chain handles it. Hard-cast id::text so a non-uuid
// param 400s without poisoning the connection with a 22P02.
router.delete(
  "/applications/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  portalLimiter,
  safeHandler(async (req: any, res: Response) => {
    if (!ensureReady(res)) {
      return;
    }
    const applicationId = toStringSafe(req.params.id);
    if (!applicationId || !/^[0-9a-f-]{36}$/i.test(applicationId)) {
      throw new AppError("validation_error", "Application id required.", 400);
    }
    const silo = getSilo(res);
    // Silo-scoped delete: a BF admin should not be able to delete a BI
    // or SLF row by guessing the uuid. Mirror the silo guard the GET
    // /:id handler implicitly applies via findApplicationById -> details.
    const owner = await runQuery<{ silo: string | null }>(
      `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    if (!owner.rows[0]) {
      res.status(404).json({ code: "not_found", message: "Application not found." });
      return;
    }
    if (owner.rows[0].silo && silo && owner.rows[0].silo !== silo) {
      res.status(404).json({ code: "not_found", message: "Application not found." });
      return;
    }
    // BF_SERVER_BLOCK_v189_DELETE_DRAFT_CASCADE_v1
    // Production schema has FKs from many tables to applications.id without
    // ON DELETE CASCADE (only the 087 job_tables migration declares CASCADE).
    // Plain DELETE FROM applications fails with 23503 foreign_key_violation
    // and PipelinePage shows "Delete failed. Please try again." Wrap the
    // delete in a transaction that first removes rows from every table that
    // carries application_id. Each child delete is wrapped in its own
    // savepoint so a missing table (undefined_table 42P01) is non-fatal —
    // we just skip it and continue. This keeps the route forward-compatible
    // with environments where some of these tables don't exist yet.
    const childTables = [
      "application_contacts",
      "application_lender_selections",
      "application_packages",
      "application_tasks",
      "application_notes",
      "documents",
      "document_requirements",
      "credit_summaries",
      "banking_analyses",
      "banking_monthly_summaries",
      "banking_transactions",
      "communications_messages",
      "crm_notes",
      "readiness_application_mappings",
    ];
    const client = await pool.connect();
    let rowCount = 0;
    try {
      await client.query("BEGIN");
      for (const tbl of childTables) {
        try {
          await client.query("SAVEPOINT s");
          await client.query(
            `DELETE FROM ${tbl} WHERE application_id::text = ($1)::text`,
            [applicationId]
          );
          await client.query("RELEASE SAVEPOINT s");
        } catch (e: any) {
          // 42P01 = undefined_table; skip silently. Anything else, let the
          // transaction abort and the catch below 500.
          if (e?.code === "42P01") {
            await client.query("ROLLBACK TO SAVEPOINT s");
            await client.query("RELEASE SAVEPOINT s");
          } else {
            throw e;
          }
        }
      }
      const r = await client.query(
        `DELETE FROM applications WHERE id::text = ($1)::text`,
        [applicationId]
      );
      rowCount = r.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (!rowCount) {
      res.status(404).json({ code: "not_found", message: "Application not found." });
      return;
    }
    res.status(200).json({ ok: true });
  })
);


router.get(
  "/applications/:id/history",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    ensureAuditHistoryEnabled();
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const actorType =
      typeof toStringSafe(req.query.actorType) === "string" ? toStringSafe(req.query.actorType).trim() : "";
    const fromStage =
      typeof toStringSafe(req.query.fromStage) === "string" ? toStringSafe(req.query.fromStage).trim() : "";
    const toStage =
      typeof toStringSafe(req.query.toStage) === "string" ? toStringSafe(req.query.toStage).trim() : "";
    const trigger =
      typeof toStringSafe(req.query.trigger) === "string" ? toStringSafe(req.query.trigger).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values: Array<string | number> = [applicationId];
    const filters: string[] = [];
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
    const result = await runQuery<{
      application_id: string;
      from_stage: string | null;
      to_stage: string;
      trigger: string;
      actor_id: string | null;
      actor_role: string | null;
      actor_type: string;
      occurred_at: Date;
      reason: string | null;
    }>(
      `select application_id, from_stage, to_stage, trigger, actor_id, actor_role,
              actor_type, occurred_at, reason
       from application_pipeline_history
       where application_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`,
      values
    );
    res.status(200).json({ items: result.rows ?? [] });
  })
);

router.get(
  "/jobs/:id/history",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    ensureAuditHistoryEnabled();
    const jobId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!jobId) {
      throw new AppError("validation_error", "Job id is required.", 400);
    }
    const jobType =
      typeof toStringSafe(req.query.jobType) === "string" ? toStringSafe(req.query.jobType).trim() : "";
    const nextStatus =
      typeof toStringSafe(req.query.nextStatus) === "string" ? toStringSafe(req.query.nextStatus).trim() : "";
    const actorType =
      typeof toStringSafe(req.query.actorType) === "string" ? toStringSafe(req.query.actorType).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values: Array<string | number> = [jobId];
    const filters: string[] = [];
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
    const result = await runQuery<{
      job_id: string;
      job_type: string;
      application_id: string | null;
      document_id: string | null;
      previous_status: string | null;
      next_status: string;
      reason: string | null;
      retry_count: number;
      last_retry_at: Date | null;
      occurred_at: Date;
      actor_type: string;
      actor_id: string | null;
    }>(
      `select job_id, job_type, application_id, document_id, previous_status, next_status,
              reason, retry_count, last_retry_at, occurred_at, actor_type, actor_id
       from processing_job_history
       where job_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`,
      values
    );
    res.status(200).json({ items: result.rows ?? [] });
  })
);

router.get(
  "/documents/:id/history",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    ensureAuditHistoryEnabled();
    const documentId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!documentId) {
      throw new AppError("validation_error", "Document id is required.", 400);
    }
    const nextStatus =
      typeof toStringSafe(req.query.nextStatus) === "string" ? toStringSafe(req.query.nextStatus).trim() : "";
    const actorType =
      typeof toStringSafe(req.query.actorType) === "string" ? toStringSafe(req.query.actorType).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values: Array<string | number> = [documentId];
    const filters: string[] = [];
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
    const result = await runQuery<{
      application_id: string;
      document_id: string;
      document_type: string;
      actor_id: string | null;
      actor_role: string | null;
      actor_type: string;
      previous_status: string | null;
      next_status: string;
      reason: string | null;
      occurred_at: Date;
    }>(
      `select application_id, document_id, document_type, actor_id, actor_role, actor_type,
              previous_status, next_status, reason, occurred_at
       from document_status_history
       where document_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`,
      values
    );
    res.status(200).json({ items: result.rows ?? [] });
  })
);

router.post(
  "/jobs/:id/retry",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const jobId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!jobId) {
      throw new AppError("validation_error", "Job id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await retryProcessingJob({
      jobId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      reason,
      force: true,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
  })
);

router.post(
  "/applications/:id/retry-job",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await retryProcessingJobForApplication({
      applicationId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      reason,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
  })
);

router.post(
  "/applications/:id/promote",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      throw new AppError("validation_error", "Reason is required.", 400);
    }
    const nextStageRaw =
      typeof req.body?.nextStage === "string" ? req.body.nextStage.trim() : "";
    if (nextStageRaw && !isPipelineState(nextStageRaw)) {
      throw new AppError("validation_error", "nextStage is invalid.", 400);
    }
    const record = await findApplicationById(applicationId);
    if (!record) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    const currentStage = assertPipelineState(record.pipeline_state);
    const nextStage = nextStageRaw && isPipelineState(nextStageRaw)
      ? nextStageRaw
      : resolveNextPipelineStage(currentStage);
    if (!nextStage) {
      throw new AppError("invalid_transition", "No valid next stage.", 400);
    }
    const transition = assertPipelineTransition({
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
      ...(req.get("user-agent") ? { userAgent: req.get("user-agent") as string } : {}),
    };
    await transitionPipelineState({
      applicationId,
      nextState: nextStage,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      trigger: "admin_promotion",
      reason,
      ...promoteMeta,
    });
    await recordAuditEvent({
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
    await advanceProcessingStage({ applicationId });
    res.status(200).json({ ok: true, applicationId, nextStage });
  })
);


router.patch(
  "/applications/:id/status",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowedManualStatuses = new Set<string>([
      ApplicationStage.ADDITIONAL_STEPS_REQUIRED,
      ApplicationStage.ACCEPTED,
      ApplicationStage.REJECTED,
    ]);
    if (!status || !isPipelineState(status) || !allowedManualStatuses.has(status)) {
      throw new AppError("validation_error", "status is invalid.", 400);
    }
    // BF_SERVER_BLOCK_v309_PORTAL_SILO_ENFORCEMENT_v1
    // Without this guard, staff in any silo could PATCH the pipeline state
    // of an application in any other silo by knowing its UUID. transitionPipelineState
    // doesn't itself enforce silo. Check before transitioning. 404 on mismatch
    // to avoid leaking that the application exists in another silo.
    {
      const callerSilo = getSilo(res);
      const ownerRow = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [applicationId]
      );
      if (!ownerRow.rows[0]) {
        throw new AppError("not_found", "Application not found.", 404);
      }
      const recordSilo = ownerRow.rows[0].silo;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        throw new AppError("not_found", "Application not found.", 404);
      }
    }
    const statusMeta = {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.get("user-agent") ? { userAgent: req.get("user-agent") as string } : {}),
    };
    await transitionPipelineState({
      applicationId,
      nextState: status,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      trigger: "manual_status_update",
      reason: typeof req.body?.reason === "string" ? req.body.reason.trim() : null,
      ...statusMeta,
    });
    res.status(200).json({ ok: true, applicationId, status });
  })
);

router.post(
  "/applications/:id/retry",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await retryProcessingJobForApplication({
      applicationId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      reason,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
  })
);

// ── Issues ───────────────────────────────────────────────────────────────────
router.get(
  "/issues",
  requireAuth,
  safeHandler(async (_req: any, res: any) => {
    const result = await runQuery(
      `SELECT i.id, i.title, i.description, i.screenshot_url, i.status,
              i.contact_id, i.application_id, i.submitted_by, i.created_at
       FROM issues i
       ORDER BY i.created_at DESC
       LIMIT 100`,
      []
    );
    res.json({ issues: result.rows ?? [] });
  })
);

router.patch(
  "/issues/:id/status",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!["open", "in_progress", "resolved"].includes(status)) {
      throw new AppError("validation_error", "Invalid status.", 400);
    }
    const result = await runQuery(
      `UPDATE issues SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (!result.rows[0]) throw new AppError("not_found", "Issue not found.", 404);
    res.json({ issue: result.rows[0] });
  })
);

// BF_SERVER_BLOCK_v133_PORTAL_LENDER_AUTH_v1 — AUDIT-8
router.get(
  "/lenders",
  requireAuth,
  portalLimiter,
  safeHandler(async (_req: any, res: any) => {
    const silo = getSilo(res);
    const lenders = await listLenders(pool, silo);
    res.status(200).json({ items: lenders ?? [] });
  })
);

// BF_SERVER_BLOCK_v203_DOC_PREVIEW_ENDPOINT_v1
// Streams the document binary inline so staff can preview PDFs/images in the
// browser. The portal calls this via apiBlob (authenticated fetch), then opens
// the response as a Blob URL. We don't generate Azure SAS URLs because the
// fetch flow keeps the bearer-auth path and avoids leaking storage URLs to
// browser history.
router.get(
  "/documents/:id/file",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const docId = String(req.params.id ?? "").trim();
    if (!docId) throw new AppError("validation_error", "Document id required.", 400);

    // BF_SERVER_BLOCK_v206_LENDER_CATEGORY_FILTER_AND_PREVIEW_FALLBACK_v1
    // Public-upload writes blob_name + storage_path but leaves storage_key NULL,
    // so the original handler always 404'd on freshly-uploaded docs. Read all
    // three columns and fall back through them in order.
    const docResult = await runQuery<{
      id: string;
      application_id: string;
      filename: string | null;
      storage_key: string | null;
      blob_name: string | null;
      storage_path: string | null;
      title: string | null;
    }>(
      `SELECT id, application_id, filename, storage_key, blob_name, storage_path, title
         FROM documents
        WHERE id::text = ($1)::text
        LIMIT 1`,
      [docId]
    );
    const doc = docResult.rows[0];
    if (!doc) throw new AppError("not_found", "Document not found.", 404);

    // Silo check via parent application.
    const appResult = await runQuery<{ silo: string | null }>(
      `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [doc.application_id]
    );
    const silo = getSilo(res);
    const appSilo = appResult.rows[0]?.silo ?? null;
    if (appSilo && silo && appSilo !== silo) {
      throw new AppError("not_found", "Document not found.", 404);
    }

    // Prefer the active version's metadata (storageKey + mimeType + fileName)
    // since that's what the portal's /applications/:id endpoint surfaces.
    const version = await findActiveDocumentVersion({ documentId: doc.id });
    const vmeta =
      version && version.metadata && typeof version.metadata === "object"
        ? (version.metadata as { storageKey?: string; mimeType?: string; fileName?: string })
        : {};

    const storageKey = vmeta.storageKey ?? doc.storage_key ?? doc.blob_name ?? doc.storage_path;
    if (!storageKey) {
      throw new AppError("not_found", "Document file not available.", 404);
    }

    const storage = getStorage();
    const fileResult = await storage.get(storageKey);
    if (!fileResult) {
      throw new AppError("not_found", "Document file not available.", 404);
    }

    const fname = vmeta.fileName ?? doc.filename ?? doc.title ?? `document-${docId}`;
    const safeFname = String(fname).replace(/[\r\n"\\]/g, "");
    const mime = vmeta.mimeType ?? fileResult.contentType ?? inferMimeFromFilename(safeFname);

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename="${safeFname}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(fileResult.buffer);
  })
);

function inferMimeFromFilename(name: string): string {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "pdf":  return "application/pdf";
    case "png":  return "image/png";
    case "jpg":  case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "svg":  return "image/svg+xml";
    case "txt":  return "text/plain; charset=utf-8";
    case "csv":  return "text/csv; charset=utf-8";
    case "json": return "application/json";
    case "html": case "htm": return "text/html; charset=utf-8";
    default:     return "application/octet-stream";
  }
}

// ── Portal document reject with auto-SMS ──────────────────────────────────────
router.post(
  "/documents/:id/accept",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const docId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!docId) throw new AppError("validation_error", "Document id required.", 400);

    const updated = await runQuery<{ id: string; document_type: string; application_id: string; status: string }>(
      `UPDATE documents SET status = 'accepted', updated_at = now()
       WHERE id = $1 RETURNING id, document_type, application_id, status`,
      [docId]
    );
    const doc = updated.rows[0];
    if (!doc) throw new AppError("not_found", "Document not found.", 404);
    // BF_SERVER_BLOCK_v309_PORTAL_SILO_ENFORCEMENT_v1
    // Pre-fix, any staff could accept a document on any application by id,
    // which (a) transitioned the application pipeline_state cross-silo, and
    // (b) fired computeAndCacheLenderMatches against a cross-silo app.
    // The UPDATE has already run by this point — rolling it back via a
    // second UPDATE keeps the data store consistent. 404 to avoid leaking
    // that the document exists in another silo.
    const appId = doc.application_id;
    if (appId) {
      const callerSilo = getSilo(res);
      const ownerRow = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [appId]
      );
      const recordSilo = ownerRow.rows[0]?.silo ?? null;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        await runQuery(
          `UPDATE documents SET status = 'pending_review', updated_at = now() WHERE id = $1`,
          [docId]
        ).catch(() => {});
        throw new AppError("not_found", "Document not found.", 404);
      }
    }
    if (appId && await allDocumentsAccepted(appId)) {
      const appRes = await runQuery<{ pipeline_state: string }>(
        `SELECT pipeline_state FROM applications WHERE id::text = ($1)::text`,
        [appId]
      );
      const cur = appRes.rows[0]?.pipeline_state;
      if (cur && ["In Review", "Documents Required", "Additional Steps Required"].includes(cur)) {
        await runQuery(
          `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now() WHERE id::text = ($1)::text`,
          [appId]
        ).catch(() => {});
        await recordTransition(appId, cur, "Off to Lender", req.user?.userId ?? null, "All documents accepted");
      }
    }
    try {
      void progressSubmission({ pool, applicationId: appId }).catch((e) => {
        console.warn("[doc-accept] progressSubmission failed", e);
      });
    } catch (e) {
      console.warn("[doc-accept] orchestrator import failed", e);
    }
    // BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
    if (appId) {
      try {
        const outstanding = await getOutstandingRequiredDocs(appId);
        if (outstanding.length === 0) {
          void computeAndCacheLenderMatches(appId).catch((err) => {
            console.warn("[doc-accept] computeAndCacheLenderMatches failed", err);
          });
        }
      } catch (err) {
        console.warn("[doc-accept] v198 gate check failed", err);
      }
    }
    res.status(200).json({ ok: true, document: doc });
  })
);

// ── Portal document reject with auto-SMS ──────────────────────────────────────
router.post(
  "/documents/:id/reject",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const docId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!docId) throw new AppError("validation_error", "Document id required.", 400);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;

    const updated = await runQuery<{
      id: string; document_type: string; application_id: string; status: string;
    }>(
      `UPDATE documents SET status = 'rejected', rejection_reason = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, document_type, application_id, status`,
      [docId, reason]
    );
    const doc = updated.rows[0];
    if (!doc) throw new AppError("not_found", "Document not found.", 404);
    // BF_SERVER_BLOCK_v309_PORTAL_SILO_ENFORCEMENT_v1
    // Pre-fix, any staff could reject a cross-silo document, which (a)
    // transitioned the cross-silo application pipeline_state, and (b)
    // fired an auto-SMS to the cross-silo applicant. Mirror the accept
    // handler's rollback: UPDATE has already run, undo it before 404.
    if (doc.application_id) {
      const callerSilo = getSilo(res);
      const ownerRow = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [doc.application_id]
      );
      const recordSilo = ownerRow.rows[0]?.silo ?? null;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        await runQuery(
          `UPDATE documents SET status = 'pending_review', rejection_reason = NULL, updated_at = now() WHERE id = $1`,
          [docId]
        ).catch(() => {});
        throw new AppError("not_found", "Document not found.", 404);
      }
    }
    // BF_SERVER_BLOCK_v198_LENDER_MATCH_GATE_AND_CACHE_v1
    if (doc.application_id) {
      void markLenderMatchesStale(doc.application_id).catch((err) => {
        console.warn("[doc-reject] markLenderMatchesStale failed", err);
      });
    }

    // Fire auto-SMS asynchronously — non-blocking
    void sendDocumentRejectionSms({
      documentId: docId,
      documentType: doc.document_type ?? "document",
      applicationId: doc.application_id,
      rejectionReason: reason,
    });

    if (doc.application_id) {
      const appRes = await runQuery<{ pipeline_state: string }>(
        `SELECT pipeline_state FROM applications WHERE id::text = ($1)::text`,
        [doc.application_id]
      );
      const cur = appRes.rows[0]?.pipeline_state;
      if (cur && ["In Review", "Off to Lender", "Received"].includes(cur)) {
        await runQuery(
          `UPDATE applications SET pipeline_state = 'Documents Required', updated_at = now() WHERE id::text = ($1)::text`,
          [doc.application_id]
        ).catch(() => {});
        await recordTransition(
          doc.application_id,
          cur,
          "Documents Required",
          req.user?.userId ?? null,
          `Document rejected: ${doc.document_type}`
        );
      }
    }

    res.status(200).json({ ok: true, document: doc });
  })
);

// BF_AZURE_OCR_TERMSHEET_v44 — real term-sheet upload (Phase 1-BF item 4).
const termSheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post(
  "/applications/:id/term-sheet",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  termSheetUpload.single("file"),
  safeHandler(async (req: any, res: any) => {
    const appId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!appId) throw new AppError("validation_error", "Application id required.", 400);
    const file = req.file as Express.Multer.File | undefined;
    if (!file) throw new AppError("validation_error", "Term sheet file is required.", 400);

    const lenderName = typeof req.body?.lender_name === "string" ? req.body.lender_name.trim() : "";
    if (!lenderName) throw new AppError("validation_error", "lender_name is required.", 400);
    const amountRaw = req.body?.amount;
    const amount = amountRaw === undefined || amountRaw === null || amountRaw === "" ? null : Number(amountRaw);
    if (amount !== null && !Number.isFinite(amount)) {
      throw new AppError("validation_error", "amount must be numeric.", 400);
    }
    const rateFactor = typeof req.body?.rate_factor === "string" ? req.body.rate_factor.trim() : null;
    const term = typeof req.body?.term === "string" ? req.body.term.trim() : null;
    const paymentFrequency = typeof req.body?.payment_frequency === "string" ? req.body.payment_frequency.trim() : null;
    const expiryDate = typeof req.body?.expiry_date === "string" && req.body.expiry_date.trim() ? req.body.expiry_date.trim() : null;
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : null;

    // BF_SERVER_BLOCK_v319_TERM_SHEET_SILO_v1
    // Pre-fix, term-sheet upload had no silo check. Staff in any silo could:
    //   (a) archive all existing offers on a cross-silo application
    //       (the UPDATE...SET is_archived = TRUE just below this guard),
    //   (b) INSERT a new offer record cross-silo,
    //   (c) upload a file to blob storage (cost),
    //   (d) trigger the auto-SMS to the cross-silo applicant via the
    //       v308 phone-lookup pipeline below.
    // Add the guard BEFORE any of those side effects. 404 to avoid
    // leaking that the application exists in another silo. Pattern
    // mirrors v309 portal handlers.
    {
      const callerSilo = getSilo(res);
      const ownerRow = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [appId]
      );
      if (!ownerRow.rows[0]) {
        throw new AppError("not_found", "Application not found.", 404);
      }
      const recordSilo = ownerRow.rows[0].silo;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        throw new AppError("not_found", "Application not found.", 404);
      }
    }

    const store = getStorage();
    const put = await store.put({
      buffer: file.buffer,
      filename: file.originalname,
      contentType: file.mimetype,
      pathPrefix: `applications/${appId}/term-sheets`,
    });

    await runQuery(
      `UPDATE offers SET is_archived = TRUE, archived_at = now(), updated_at = now()
        WHERE application_id::text = ($1)::text AND is_archived = FALSE`,
      [appId]
    ).catch(() => {});

    const offerId = randomUUID();
    await runQuery(
      `INSERT INTO offers (
         id, application_id, lender_name, amount, rate_factor, term, payment_frequency,
         expiry_date, document_url, notes, status, recommended,
         term_sheet_blob_name, term_sheet_filename, term_sheet_size_bytes, term_sheet_uploaded_at,
         is_archived, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', false,
               $11, $12, $13, now(), false, now(), now())`,
      [
        offerId, appId, lenderName, amount, rateFactor, term, paymentFrequency,
        expiryDate, put.url, notes,
        put.blobName, file.originalname, put.sizeBytes,
      ]
    );

    const appRes = await runQuery<{ pipeline_state: string }>(
      `SELECT pipeline_state FROM applications WHERE id::text = ($1)::text`,
      [appId]
    );
    const cur = appRes.rows[0]?.pipeline_state;
    if (cur === "Off to Lender") {
      await runQuery(
        `UPDATE applications SET pipeline_state = 'Offer', updated_at = now() WHERE id::text = ($1)::text`,
        [appId]
      ).catch(() => {});
      await recordTransition(appId, "Off to Lender", "Offer", req.user?.userId ?? null, "Term sheet uploaded");
    }

    eventBus.emit("term_sheet_uploaded", { applicationId: appId, offerId, blobName: put.blobName });

    try {
      const phoneRes = await runQuery<{ phone: string | null }>(
        `SELECT COALESCE(applicant_phone, contact_phone, NULL) AS phone
           FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [appId]
      );
      const phone = phoneRes.rows[0]?.phone ?? null;
      if (phone) {
        const portalBase = process.env.CLIENT_PORTAL_URL || "https://client.boreal.financial";
        const link = `${portalBase}/application/${appId}`;
        await sendSMS(phone, `Your term sheet from ${lenderName} is ready to review: ${link}`);
      }
    } catch (err) {
      console.warn("[term-sheet] SMS notification failed", { appId, err: String(err) });
    }

    res.status(201).json({ ok: true, offer_id: offerId, blob_name: put.blobName, stage: cur === "Off to Lender" ? "Offer" : cur });
  })
);

router.post(
  "/lender-submissions",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    // BF_LENDER_SUBMIT_BODY_COMPAT_v42 — Block 42-A
    // Accept either snake_case (application_id, selected_lenders) or camelCase
    // (applicationId, lenderProductIds). The portal's lenders.ts API client
    // sends camelCase; the iOS dialer / older callers send snake_case. Both
    // are now valid.
    const applicationIdRaw =
      (typeof req.body?.application_id === "string" && req.body.application_id) ||
      (typeof req.body?.applicationId  === "string" && req.body.applicationId)  ||
      "";
    const applicationId = applicationIdRaw.trim();
    const selectedLenders: unknown[] = Array.isArray(req.body?.selected_lenders)
      ? req.body.selected_lenders
      : Array.isArray(req.body?.lenderProductIds)
        ? req.body.lenderProductIds
        : Array.isArray(req.body?.lender_product_ids)
          ? req.body.lender_product_ids
          : [];
    if (!applicationId || selectedLenders.length === 0) {
      throw new AppError("validation_error", "application_id (or applicationId) and lenderProductIds are required.", 400);
    }

    const submissions: any[] = [];
    for (const lenderId of selectedLenders) {
      const result = await runQuery(
        `insert into lender_submissions (id, application_id, lender_id, status, idempotency_key, payload, submitted_at, created_at, updated_at)
         values ($1, $2, $3, 'submitted', $4, $5, now(), now(), now())
         on conflict (application_id, lender_id) do update
         set status = excluded.status,
             payload = excluded.payload,
             submitted_at = now(),
             updated_at = now()
         returning id, application_id, lender_id, status, submitted_at, created_at`,
        [randomUUID(), applicationId, String(lenderId), randomUUID(), JSON.stringify({ package: 'generated', documents: 'attached', credit_summary: 'attached' })]
      );
      if (result.rows[0]) {
        submissions.push(result.rows[0]);
        eventBus.emit("lender_submission_created", {
          submissionId: result.rows[0].id,
          applicationId,
          lenderId: result.rows[0].lender_id,
        });
      }
    }

    res.status(201).json({ submissions });
  })
);

router.get(
  "/offers",
  // BF_SERVER_BLOCK_v318_PORTAL_OFFERS_GET_AUTH_v1
  // Pre-fix this endpoint had only portalLimiter — NO requireAuth, NO role
  // check, NO silo filter. Anyone on the internet could:
  //   - GET /api/portal/offers           → top 100 offers across all silos
  //                                        (lender_name, amount, rate_factor,
  //                                        term, status, document_url)
  //   - GET /api/portal/offers?applicationId=<uuid>
  //                                      → every active offer on that app
  // Lender offer pricing is highly sensitive (negotiated terms per-applicant).
  // Companion POST /offers below was properly auth+role gated — this GET was
  // a mount oversight, not an intentional public surface. No production UI
  // calls this path (verified across BF-portal, BF-client, BF-Website), so
  // adding the standard staff gate does not break any legitimate flow.
  // Silo filter mirrors v314 offers.ts pattern.
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof toStringSafe(req.query.applicationId) === "string" ? toStringSafe(req.query.applicationId).trim() : "";
    const callerSilo = getSilo(res) ?? null;
    // BF_MINI_PORTAL_NOTES_v47 — only return active (non-archived) offers.
    const query = applicationId
      ? {
          text: `select o.id, o.application_id, o.lender_name, o.amount::text as amount, o.rate_factor, o.term, o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
                 from offers o
                 join applications a on a.id::text = o.application_id::text
                 where o.application_id = $1
                   and coalesce(o.is_archived, false) = false
                   and ($2::text is null or a.silo is null or a.silo = $2::text)
                 order by o.updated_at desc`,
          values: [applicationId, callerSilo],
        }
      : {
          text: `select o.id, o.application_id, o.lender_name, o.amount::text as amount, o.rate_factor, o.term, o.payment_frequency, o.expiry_date, o.document_url, o.recommended, o.status, o.created_at, o.updated_at
                 from offers o
                 join applications a on a.id::text = o.application_id::text
                 where coalesce(o.is_archived, false) = false
                   and ($1::text is null or a.silo is null or a.silo = $1::text)
                 order by o.updated_at desc
                 limit 100`,
          values: [callerSilo],
        };
    const rows = await runQuery(query.text, query.values);
    res.status(200).json({ items: rows.rows });
  })
);

router.post(
  "/offers",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lenderName = typeof req.body?.lenderName === "string" ? req.body.lenderName.trim() : "";
    if (!applicationId || !lenderName) {
      throw new AppError("validation_error", "applicationId and lenderName are required.", 400);
    }
    const result = await runQuery(
      `insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, 'created'), $12, now(), now())
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [
        randomUUID(),
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
      ]
    );
    if (result.rows[0]) {
      eventBus.emit("offer_created", { offerId: result.rows[0].id, applicationId });
    }
    res.status(201).json({ offer: result.rows[0] });
  })
);

// BF_MINI_PORTAL_NOTES_v47 — client-facing offer disposition (accept / decline).
// Public on purpose: the offer id is the bearer credential, mirroring /public-upload.
router.post(
  "/offers/:id/accept",
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "offer id required.", 400);
    const upd = await runQuery<{ application_id: string }>(
      `UPDATE offers SET status='accepted', updated_at=now()
        WHERE id=$1 AND coalesce(is_archived,false)=false AND status IN ('pending','created','sent')
        RETURNING application_id`,
      [id]
    );
    if (!upd.rows[0]) throw new AppError("not_found", "Offer not available for acceptance.", 404);
    const appId = upd.rows[0].application_id;
    await runQuery(
      `UPDATE applications SET pipeline_state='Accepted', updated_at=now()
        WHERE id::text = ($1)::text AND pipeline_state IN ('Offer','Off to Lender')`,
      [appId]
    ).catch(() => {});
    eventBus.emit("offer_accepted", { offerId: id, applicationId: appId });
    res.status(200).json({ ok: true, offer_id: id, status: "accepted" });
  })
);

router.post(
  "/offers/:id/decline",
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!id) throw new AppError("validation_error", "offer id required.", 400);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 500) : null;
    const upd = await runQuery<{ application_id: string }>(
      `UPDATE offers SET status='changes_requested', notes=COALESCE($2, notes), updated_at=now()
        WHERE id=$1 AND coalesce(is_archived,false)=false AND status IN ('pending','created','sent')
        RETURNING application_id`,
      [id, reason]
    );
    if (!upd.rows[0]) throw new AppError("not_found", "Offer not available for decline.", 404);
    eventBus.emit("offer_declined", { offerId: id, applicationId: upd.rows[0].application_id, reason });
    res.status(200).json({ ok: true, offer_id: id, status: "changes_requested", reason });
  })
);

router.patch(
  "/offers/:id/status",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const id = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
      throw new AppError("validation_error", "Valid status is required.", 400);
    }
    const updated = await runQuery(
      `update offers
       set status = $2, updated_at = now()
       where id = $1
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [id, status]
    );
    if (!updated.rows[0]) {
      throw new AppError("not_found", "Offer not found.", 404);
    }
    if (updated.rows[0] && status === "accepted") {
      eventBus.emit("offer_accepted", { offerId: updated.rows[0].id, applicationId: updated.rows[0].application_id });
    }
    res.status(200).json({ offer: updated.rows[0] });
  })
);


// BF_SERVER_BLOCK_v205_OPEN_APPLICATION_ROUTE_v1
// POST /api/portal/applications/:id/open — staff signals they have opened
// the application card. Calls openApplicationForStaff which advances
// Received -> In Review on first open and stamps first_opened_at. Safe to
// call repeatedly; a no-op when the application is already past Received.
router.post(
  "/applications/:id/open",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = toStringSafe(req.params.id).trim();
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const ip = req.ip;
    const userAgent = req.get("user-agent");
    await openApplicationForStaff({
      applicationId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      ...(ip ? { ip } : {}),
      ...(typeof userAgent === "string" ? { userAgent } : {}),
    });
    res.status(200).json({ ok: true, applicationId });
  })
);


// BF_SERVER_BLOCK_v207_OCR_DIAGNOSTIC_ENDPOINT_v1
// Returns the OCR + banking pipeline state for an application so staff can
// see why Banking/Financials tabs aren't showing data. Admin/staff only.
router.get(
  "/applications/:id/ocr-diagnostic",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const applicationId = toStringSafe(req.params.id).trim();
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }

    const appRow = await runQuery<{
      id: string;
      pipeline_state: string | null;
      banking_completed_at: Date | null;
      silo: string | null;
    }>(
      `SELECT id, pipeline_state, banking_completed_at, silo
         FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    );
    const app = appRow.rows[0];
    if (!app) throw new AppError("not_found", "Application not found.", 404);
    // BF_SERVER_BLOCK_v309_PORTAL_SILO_ENFORCEMENT_v1
    // The handler already SELECTed silo but never compared it. Without this
    // guard, any staff could read the full OCR + banking pipeline state of
    // any application by id, including failed-job error strings (which can
    // contain provider keys / file paths) and OCR field-extraction breakdowns.
    {
      const callerSilo = getSilo(res);
      if (app.silo && callerSilo && app.silo !== callerSilo) {
        throw new AppError("not_found", "Application not found.", 404);
      }
    }

    // Documents and their OCR status as recorded in the documents table itself.
    const docsRow = await runQuery<{
      total: string;
      categories: any;
      ocr_breakdown: any;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         jsonb_object_agg(COALESCE(document_type, signed_category, 'unknown'), per_cat) AS categories,
         jsonb_object_agg(COALESCE(ocr_status, 'null'), per_status) AS ocr_breakdown
       FROM (
         SELECT document_type, signed_category, ocr_status,
                COUNT(*) OVER (PARTITION BY COALESCE(document_type, signed_category)) AS per_cat,
                COUNT(*) OVER (PARTITION BY COALESCE(ocr_status, 'null')) AS per_status
           FROM documents
          WHERE application_id::text = ($1)::text
       ) sub`,
      [applicationId]
    ).catch(() => ({ rows: [{ total: "0", categories: null, ocr_breakdown: null }] } as any));

    // OCR jobs for this application.
    const jobsRow = await runQuery<{
      total: string;
      by_status: any;
      last_errors: any;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         jsonb_object_agg(status, cnt) AS by_status,
         jsonb_agg(jsonb_build_object(
           'documentId', document_id, 'status', status,
           'attemptCount', attempt_count, 'lastError', last_error
         )) FILTER (WHERE status = 'failed') AS last_errors
       FROM (
         SELECT document_id, status, attempt_count, last_error,
                COUNT(*) OVER (PARTITION BY status) AS cnt
           FROM ocr_jobs
          WHERE application_id::text = ($1)::text
       ) sub`,
      [applicationId]
    ).catch(() => ({ rows: [{ total: "0", by_status: null, last_errors: null }] } as any));

    // Banking analysis state.
    const bankingRow = await runQuery<{
      exists: boolean;
      status: string | null;
      analysis_completed_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT TRUE AS exists, status, analysis_completed_at, last_error
         FROM banking_analyses WHERE application_id::text = ($1)::text LIMIT 1`,
      [applicationId]
    ).catch(() => ({ rows: [] } as any));
    const banking = bankingRow.rows[0] ?? { exists: false, status: null, analysis_completed_at: null, last_error: null };

    // Build a one-line diagnosis from the data above.
    const totalDocs = Number(docsRow.rows[0]?.total ?? "0");
    const totalJobs = Number(jobsRow.rows[0]?.total ?? "0");
    const byStatus = (jobsRow.rows[0]?.by_status ?? {}) as Record<string, number>;
    const failedCount = Number(byStatus.failed ?? 0);
    const queuedCount = Number(byStatus.queued ?? 0);
    const processingCount = Number(byStatus.processing ?? 0);
    const completedCount = Number(byStatus.completed ?? byStatus.success ?? 0);

    let diagnosis: string;
    if (totalDocs === 0) {
      diagnosis = "No documents uploaded for this application yet.";
    } else if (totalJobs === 0) {
      diagnosis = `${totalDocs} documents uploaded but no OCR jobs were enqueued. Check enqueueOcrForDocument call site.`;
    } else if (failedCount === totalJobs) {
      const firstErr = (jobsRow.rows[0]?.last_errors ?? [])[0]?.lastError ?? "(no error recorded)";
      diagnosis = `All ${totalJobs} OCR jobs FAILED. First error: ${firstErr}. Most likely OPENAI_API_KEY invalid or OCR provider rejecting requests.`;
    } else if (queuedCount > 0 && completedCount === 0) {
      diagnosis = `${queuedCount} OCR jobs queued and never processed. Worker not picking them up — check application pipeline_state (must be past 'draft') and OCR_ENABLED flag.`;
    } else if (processingCount > 0 && totalJobs > processingCount) {
      diagnosis = `${processingCount} OCR jobs stuck in 'processing'. Worker may have crashed mid-job. Locks expire after the lock timeout, then jobs retry.`;
    } else if (completedCount === totalJobs && !banking.exists) {
      diagnosis = `All OCR done but no banking_analyses row exists. bankingAutoWorker likely not running, or no docs match the bank-statement filter.`;
    } else if (banking.exists && banking.status === "failed") {
      diagnosis = `Banking analysis FAILED: ${banking.last_error ?? "(no error recorded)"}`;
    } else if (banking.exists && banking.analysis_completed_at) {
      diagnosis = "Pipeline healthy. Banking analysis complete. If tab still shows blank, frontend rendering issue.";
    } else {
      diagnosis = `Mixed state: ${completedCount}/${totalJobs} OCR jobs complete, ${failedCount} failed, ${queuedCount} queued. Banking exists=${banking.exists}.`;
    }

    res.status(200).json({
      applicationId: app.id,
      pipelineState: app.pipeline_state,
      bankingCompletedAt: app.banking_completed_at,
      documents: {
        total: totalDocs,
        byCategory: docsRow.rows[0]?.categories ?? {},
        ocrStatusBreakdown: docsRow.rows[0]?.ocr_breakdown ?? {},
      },
      ocrJobs: {
        total: totalJobs,
        byStatus,
        failedJobs: jobsRow.rows[0]?.last_errors ?? [],
      },
      bankingAnalysis: banking,
      diagnosis,
    });
  })
);

// BF_SERVER_BLOCK_v208_EMAIL_DIAGNOSTIC_ENDPOINT_v1
// Non-destructive diagnostic for the Microsoft Graph email send pipeline.
// Reports whether (a) all four MS_GRAPH_* env vars are set, (b) Graph token
// acquisition works, (c) the send-as mailbox resolves and is visible to the
// app registration. Does NOT send any email. Admin/staff only.
router.get(
  "/email-diagnostic",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (_req: any, res: any) => {
    const envCheck: Record<string, "set" | "missing"> = {
      MS_GRAPH_TENANT_ID:    process.env.MS_GRAPH_TENANT_ID    && process.env.MS_GRAPH_TENANT_ID.trim()    ? "set" : "missing",
      MS_GRAPH_CLIENT_ID:    process.env.MS_GRAPH_CLIENT_ID    && process.env.MS_GRAPH_CLIENT_ID.trim()    ? "set" : "missing",
      MS_GRAPH_CLIENT_SECRET:process.env.MS_GRAPH_CLIENT_SECRET&& process.env.MS_GRAPH_CLIENT_SECRET.trim()? "set" : "missing",
      MS_GRAPH_SEND_AS:      process.env.MS_GRAPH_SEND_AS      && process.env.MS_GRAPH_SEND_AS.trim()      ? "set" : "missing",
    };
    const missing = Object.entries(envCheck).filter(([, v]) => v === "missing").map(([k]) => k);

    const sendAs = (process.env.MS_GRAPH_SEND_AS ?? "").trim();
    const tenant = (process.env.MS_GRAPH_TENANT_ID ?? "").trim();
    const clientId = (process.env.MS_GRAPH_CLIENT_ID ?? "").trim();
    const clientSecret = (process.env.MS_GRAPH_CLIENT_SECRET ?? "").trim();

    let tokenStep:
      | { ok: true; expiresInSec: number }
      | { ok: false; status?: number; error: string }
      | { ok: null; reason: string } = { ok: null, reason: "skipped (env vars missing)" };
    let mailboxStep:
      | { ok: true; userPrincipalName: string; displayName: string | null; mailEnabled: boolean | null }
      | { ok: false; status?: number; error: string }
      | { ok: null; reason: string } = { ok: null, reason: "skipped (no token)" };

    let token: string | null = null;

    if (missing.length === 0) {
      // Step 1: try to acquire a token via OAuth client credentials.
      try {
        const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
        const body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "client_credentials",
          scope: "https://graph.microsoft.com/.default",
        });
        const resp = await fetch(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        if (resp.status === 200) {
          const json = (await resp.json()) as { access_token?: string; expires_in?: number };
          token = String(json.access_token ?? "");
          if (token) {
            tokenStep = { ok: true, expiresInSec: Number(json.expires_in ?? 0) };
          } else {
            tokenStep = { ok: false, status: 200, error: "Graph returned no access_token" };
          }
        } else {
          const txt = (await resp.text().catch(() => "")).slice(0, 400);
          tokenStep = { ok: false, status: resp.status, error: `Token endpoint returned ${resp.status}: ${txt}` };
        }
      } catch (err: any) {
        tokenStep = { ok: false, error: `Token request threw: ${err?.message ?? String(err)}` };
      }

      // Step 2: if we have a token, try to look up the send-as mailbox.
      if (token) {
        try {
          const userUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sendAs)}?$select=userPrincipalName,displayName,mail,mailNickname`;
          const resp = await fetch(userUrl, {
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (resp.status === 200) {
            const json = (await resp.json()) as any;
            mailboxStep = {
              ok: true,
              userPrincipalName: String(json.userPrincipalName ?? sendAs),
              displayName: json.displayName ?? null,
              mailEnabled: json.mail ? true : null,
            };
          } else {
            const txt = (await resp.text().catch(() => "")).slice(0, 400);
            mailboxStep = { ok: false, status: resp.status, error: `Users endpoint returned ${resp.status}: ${txt}` };
          }
        } catch (err: any) {
          mailboxStep = { ok: false, error: `Mailbox lookup threw: ${err?.message ?? String(err)}` };
        }
      }
    }

    // Build a one-line human diagnosis.
    let diagnosis: string;
    if (missing.length > 0) {
      diagnosis = `Missing env vars: ${missing.join(", ")}. Configure these in Azure App Service → Environment variables.`;
    } else if (tokenStep && (tokenStep as any).ok === false) {
      const ts = tokenStep as { ok: false; status?: number; error: string };
      if (ts.status === 401 || /AADSTS7000215/i.test(ts.error)) {
        diagnosis = "Token acquisition FAILED: client secret is wrong or expired. Generate a new client secret in the App registration and update MS_GRAPH_CLIENT_SECRET.";
      } else if (/AADSTS90002/i.test(ts.error) || /tenant.*not.*found/i.test(ts.error)) {
        diagnosis = "Token acquisition FAILED: tenant ID is wrong (Azure AD does not recognize this tenant). Verify MS_GRAPH_TENANT_ID.";
      } else if (/AADSTS700016/i.test(ts.error) || /application.*not.*found/i.test(ts.error)) {
        diagnosis = "Token acquisition FAILED: client ID is wrong, or the App registration does not exist in this tenant. Verify MS_GRAPH_CLIENT_ID.";
      } else {
        diagnosis = `Token acquisition FAILED: ${ts.error}`;
      }
    } else if (mailboxStep && (mailboxStep as any).ok === false) {
      const ms = mailboxStep as { ok: false; status?: number; error: string };
      if (ms.status === 403 || /Authorization_RequestDenied/i.test(ms.error) || /Insufficient privileges/i.test(ms.error)) {
        diagnosis = "Token works BUT the App registration is missing required Graph permissions. In Azure AD → App registrations → API permissions, grant Application permissions: User.Read.All (to look up the sender) and Mail.Send. Then click 'Grant admin consent'.";
      } else if (ms.status === 404) {
        diagnosis = `Token works BUT the mailbox '${sendAs}' does not exist in this tenant. Either the address is wrong, or no mailbox has been created for it. Create the user/mailbox in Microsoft 365 admin center.`;
      } else {
        diagnosis = `Token works but mailbox lookup failed: ${ms.error}`;
      }
    } else if (tokenStep && (tokenStep as any).ok === true && mailboxStep && (mailboxStep as any).ok === true) {
      diagnosis = `All checks PASSED. Graph email pipeline is configured correctly. Sender '${sendAs}' is reachable. If lender packages are not arriving, the issue is downstream (Stage A/B preconditions, dispatchToSelected execution, or recipient deliverability).`;
    } else {
      diagnosis = "Inconclusive — see token and mailbox steps for details.";
    }

    res.status(200).json({
      sendAs,
      env: envCheck,
      missingEnv: missing,
      token: tokenStep,
      mailbox: mailboxStep,
      diagnosis,
    });
  })
);


// BF_SERVER_BLOCK_v211_REOCR_USE_RESET_v1
// Re-OCR every document on an application. v210 used enqueueOcrForDocument
// which uses an ON CONFLICT DO UPDATE that's a no-op for existing job rows
// (it only touches updated_at). Result: clicking "Re-run OCR" did nothing
// for documents that had ever been processed before, because status stayed
// 'succeeded' or 'failed' and the worker's lockOcrJobs gate excluded them.
// retryOcrJob calls resetOcrJob which sets status='queued', attempt_count=0,
// next_attempt_at=now(), and clears last_error — so the worker picks it up
// on the next 5-second tick.
router.post(
  "/applications/:id/reocr",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const applicationId = toStringSafe(req.params.id).trim();
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    console.log("[reocr] called", { applicationId, userId: req.user?.id ?? null });
    // BF_SERVER_BLOCK_v309_PORTAL_SILO_ENFORCEMENT_v1
    // reocr resets every document's OCR job to 'queued' which triggers the
    // worker to re-run extraction. Without this guard, cross-silo staff
    // could re-run OCR (with attendant compute cost and pipeline noise) on
    // any application by id. 404 to avoid leaking that the application
    // exists in another silo.
    {
      const callerSilo = getSilo(res);
      const appRow = await runQuery<{ silo: string | null }>(
        `SELECT silo FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [applicationId]
      );
      if (!appRow.rows[0]) {
        throw new AppError("not_found", "Application not found.", 404);
      }
      const recordSilo = appRow.rows[0].silo;
      if (recordSilo && callerSilo && recordSilo !== callerSilo) {
        throw new AppError("not_found", "Application not found.", 404);
      }
    }

    const docsRes = await runQuery<{ id: string }>(
      `SELECT id FROM documents WHERE application_id::text = ($1)::text`,
      [applicationId]
    );
    let reset = 0;
    let failed = 0;
    const errors: Array<{ documentId: string; error: string }> = [];
    for (const row of docsRes.rows) {
      try {
        const { retryOcrJob } = await import("../modules/ocr/ocr.service.js");
        await retryOcrJob(row.id);
        reset++;
      } catch (err: any) {
        failed++;
        errors.push({ documentId: row.id, error: err?.message ?? String(err) });
      }
    }
    console.log("[reocr] result", {
      applicationId,
      totalDocs: docsRes.rows.length,
      reset,
      failed,
    });
    res.status(200).json({
      applicationId,
      totalDocs: docsRes.rows.length,
      enqueued: reset,
      failed,
      errors: errors.slice(0, 10),
    });
  })
);

export default router;
