import { randomUUID } from "crypto";
import { pool } from "../../db";
import { ApplicationStage } from "./pipelineState";
import { type PoolClient } from "pg";
import { logError } from "../../observability/logger";
import { AppError } from "../../middleware/errors";

type Queryable = Pick<PoolClient, "query">;

const PIPELINE_ERROR_CODES = new Set(["22P02", "23514"]);

function isPipelineConstraintError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return typeof code === "string" && PIPELINE_ERROR_CODES.has(code);
}

function requireRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) {
    throw new AppError("data_error", `Missing ${context} record.`, 500);
  }
  return row;
}

export type ApplicationRecord = {
  id: string;
  owner_user_id: string | null;
  name: string;
  metadata: unknown | null;
  product_type: string;
  product_category: string | null;
  pipeline_state: string;
  current_stage: string | null;
  processing_stage: string;
  lender_id: string | null;
  lender_product_id: string | null;
  requested_amount: number | null;
  first_opened_at: Date | null;
  ocr_completed_at: Date | null;
  banking_completed_at: Date | null;
  credit_summary_completed_at: Date | null;
  startup_flag: boolean | null;
  created_at: Date;
  updated_at: Date;
};

export type ApplicationOcrSnapshot = {
  id: string;
  ocr_missing_fields: unknown | null;
  ocr_conflicting_fields: unknown | null;
  ocr_has_missing_fields: boolean | null;
  ocr_has_conflicts: boolean | null;
};

export type DocumentRecord = {
  id: string;
  application_id: string;
  owner_user_id: string | null;
  title: string;
  document_type: string;
  status: string;
  filename: string | null;
  storage_key: string | null;
  uploaded_by: string;
  rejection_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

export type DocumentVersionRecord = {
  id: string;
  document_id: string;
  version: number;
  blob_name: string | null;
  hash: string | null;
  metadata: unknown;
  content: string;
  created_at: Date;
};

export type DocumentVersionReviewRecord = {
  id: string;
  document_version_id: string;
  status: string;
  reviewed_by_user_id: string | null;
  reviewed_at: Date;
};

export type ApplicationStageEventRecord = {
  id: string;
  application_id: string;
  from_stage: string | null;
  to_stage: string;
  trigger: string;
  triggered_by: string;
  reason: string | null;
  created_at: Date;
};

export type ApplicationRequiredDocumentRecord = {
  id: string;
  application_id: string;
  document_category: string;
  is_required: boolean;
  status: string;
  created_at: Date;
};

function resolveInitialPipelineState(productCategory: string): ApplicationStage {
  return productCategory.trim().toLowerCase() === "startup"
    ? ApplicationStage.STARTUP
    : ApplicationStage.RECEIVED;
}

export async function createApplication(params: {
  ownerUserId: string | null;
  name: string;
  metadata: unknown | null;
  productType: string;
  productCategory?: string | null;
  trigger?: string;
  triggeredBy?: string | null;
  lenderId?: string | null;
  lenderProductId?: string | null;
  requestedAmount?: number | null;
  source?: string | null;
  client?: Queryable;
}): Promise<ApplicationRecord> {
  const runner = params.client ?? pool;
  const productCategory = params.productCategory ?? params.productType;
  const pipelineState = resolveInitialPipelineState(productCategory);
  const startupFlag = pipelineState === ApplicationStage.STARTUP;
  let res;
  try {
    res = await runner.query<ApplicationRecord>(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, lender_id, lender_product_id, requested_amount, source, startup_flag, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11, $12, now(), now())
       returning id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, processing_stage, lender_id, lender_product_id, requested_amount, first_opened_at, ocr_completed_at, banking_completed_at, credit_summary_completed_at, startup_flag, created_at, updated_at`,
      [
        randomUUID(),
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
      ]
    );
  } catch (err) {
    if (isPipelineConstraintError(err)) {
      logError("pipeline_enum_mismatch", {
        route: "/api/applications",
        code: (err as { code?: string }).code,
        message: err instanceof Error ? err.message : String(err),
      });
      throw new AppError("validation_error", "Invalid pipeline state.", 400);
    }
    throw err;
  }
  const record = requireRow<ApplicationRecord>(res.rows, "application");
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

export async function listApplications(params?: {
  limit?: number;
  offset?: number;
  stage?: string | null;
  client?: Queryable;
}): Promise<ApplicationRecord[]> {
  const runner = params?.client ?? pool;
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  const stage = params?.stage?.trim();
  const values: Array<string | number> = [limit, offset];
  const stageClause = stage
    ? `where lower(coalesce(pipeline_state, 'received')) = lower($${values.length + 1})`
    : "";
  if (stage) {
    values.push(stage);
  }
  const res = await runner.query<ApplicationRecord>(
    `select id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, processing_stage, lender_id, lender_product_id, requested_amount, first_opened_at, ocr_completed_at, banking_completed_at, credit_summary_completed_at, startup_flag, created_at, updated_at
     from applications
     ${stageClause}
     order by created_at desc
     limit $1 offset $2`,
    values
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function listApplicationPipelineStages(
  client?: Queryable
): Promise<string[]> {
  const runner = client ?? pool;
  try {
    const res = await runner.query<{ pipeline_state: string }>(
      `SELECT DISTINCT pipeline_state
       FROM applications
       ORDER BY pipeline_state`
    );
    return Array.isArray(res.rows)
      ? res.rows
          .map((row) => row.pipeline_state)
          .filter((state) => Boolean(state))
      : [];
  } catch (err) {
    logError("pipeline_stages_query_failed", {
      route: "/api/portal/applications/stages",
      stack: err instanceof Error ? err.stack : undefined,
    });
    return [];
  }
}

export async function countApplications(client?: Queryable): Promise<number> {
  const runner = client ?? pool;
  const res = await runner.query<{ total: number }>(
    "select count(*)::int as total from applications"
  );
  const first = res.rows[0];
  return Number(first?.total ?? 0);
}

export async function findApplicationById(
  id: string,
  client?: Queryable
): Promise<ApplicationRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<ApplicationRecord>(
    `select id, owner_user_id, name, metadata, product_type, product_category, pipeline_state, current_stage, status, processing_stage, lender_id, lender_product_id, requested_amount, first_opened_at, ocr_completed_at, banking_completed_at, credit_summary_completed_at, startup_flag, created_at, updated_at
     from applications
     where id = $1
     limit 1`,
    [id]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function updateApplicationStatus(params: {
  applicationId: string;
  status: string | null;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runner.query(
    `update applications
     set status = $1, updated_at = now()
     where id = $2`,
    [params.status, params.applicationId]
  );
}

export async function findApplicationOcrSnapshot(
  applicationId: string,
  client?: Queryable
): Promise<ApplicationOcrSnapshot | null> {
  const runner = client ?? pool;
  const res = await runner.query<ApplicationOcrSnapshot>(
    `select id,
            ocr_missing_fields,
            ocr_conflicting_fields,
            ocr_has_missing_fields,
            ocr_has_conflicts
     from applications
     where id = $1
     limit 1`,
    [applicationId]
  );
  return res.rows[0] ?? null;
}

export async function updateApplicationOcrInsights(params: {
  applicationId: string;
  missingFields: string[];
  conflictingFields: string[];
  normalizedValues: Record<string, string>;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runner.query(
    `update applications
     set ocr_missing_fields = $2::jsonb,
         ocr_conflicting_fields = $3::jsonb,
         ocr_normalized_values = $4::jsonb,
         ocr_has_missing_fields = $5,
         ocr_has_conflicts = $6,
         ocr_insights_updated_at = now(),
         updated_at = now()
     where id = $1`,
    [
      params.applicationId,
      JSON.stringify(params.missingFields),
      JSON.stringify(params.conflictingFields),
      JSON.stringify(params.normalizedValues),
      params.missingFields.length > 0,
      params.conflictingFields.length > 0,
    ]
  );
}

export async function updateApplicationPipelineState(params: {
  applicationId: string;
  pipelineState: string;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  try {
    await runner.query(
      `update applications
       set pipeline_state = $1,
           current_stage = $1,
           application_status = lower($1),
           is_completed = case when $1 = 'OFF_TO_LENDER' then true else is_completed end,
           last_updated = now(),
           updated_at = now()
       where id = $2`,
      [params.pipelineState, params.applicationId]
    );
  } catch (err) {
    if (isPipelineConstraintError(err)) {
      logError("pipeline_constraint_violation", {
        route: "/api/applications/:id/pipeline",
        code: (err as { code?: string }).code,
        message: err instanceof Error ? err.message : String(err),
      });
      throw new AppError("validation_error", "Invalid pipeline state.", 400);
    }
    throw err;
  }
}

export async function updateApplicationFirstOpenedAt(params: {
  applicationId: string;
  client?: Queryable;
}): Promise<boolean> {
  const runner = params.client ?? pool;
  const res = await runner.query(
    `update applications
     set first_opened_at = now(),
         updated_at = now()
     where id = $1
       and first_opened_at is null`,
    [params.applicationId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function createApplicationStageEvent(params: {
  applicationId: string;
  fromStage: string | null;
  toStage: string;
  trigger: string;
  triggeredBy: string;
  reason?: string | null;
  client?: Queryable;
}): Promise<ApplicationStageEventRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationStageEventRecord>(
    `insert into application_stage_events
     (id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at`,
    [
      randomUUID(),
      params.applicationId,
      params.fromStage,
      params.toStage,
      params.trigger,
      params.triggeredBy,
      params.reason ?? null,
    ]
  );
  return requireRow(res.rows, "application stage event");
}

export async function listApplicationStageEvents(params: {
  applicationId: string;
  client?: Queryable;
}): Promise<ApplicationStageEventRecord[]> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationStageEventRecord>(
    `select id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at
     from application_stage_events
     where application_id = $1
     order by created_at asc`,
    [params.applicationId]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function upsertApplicationRequiredDocument(params: {
  applicationId: string;
  documentCategory: string;
  isRequired: boolean;
  status: string;
  client?: Queryable;
}): Promise<ApplicationRequiredDocumentRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationRequiredDocumentRecord>(
    `insert into application_required_documents
     (id, application_id, document_category, is_required, status, created_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (application_id, document_category) do update
     set status = excluded.status,
         is_required = excluded.is_required
     returning id, application_id, document_category, is_required, status, created_at`,
    [
      randomUUID(),
      params.applicationId,
      params.documentCategory,
      params.isRequired,
      params.status,
    ]
  );
  return requireRow(res.rows, "application required document");
}

export async function ensureApplicationRequiredDocumentDefinition(params: {
  applicationId: string;
  documentCategory: string;
  isRequired: boolean;
  client?: Queryable;
}): Promise<ApplicationRequiredDocumentRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationRequiredDocumentRecord>(
    `insert into application_required_documents
     (id, application_id, document_category, is_required, status, created_at)
     values ($1, $2, $3, $4, 'missing', now())
     on conflict (application_id, document_category) do update
     set is_required = excluded.is_required
     returning id, application_id, document_category, is_required, status, created_at`,
    [
      randomUUID(),
      params.applicationId,
      params.documentCategory,
      params.isRequired,
    ]
  );
  return requireRow(res.rows, "application required document");
}

export async function listApplicationRequiredDocuments(params: {
  applicationId: string;
  client?: Queryable;
}): Promise<ApplicationRequiredDocumentRecord[]> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationRequiredDocumentRecord>(
    `select id, application_id, document_category, is_required, status, created_at
     from application_required_documents
     where application_id = $1
     order by document_category asc`,
    [params.applicationId]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function findApplicationRequiredDocumentById(params: {
  documentId: string;
  client?: Queryable;
}): Promise<ApplicationRequiredDocumentRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationRequiredDocumentRecord>(
    `select id, application_id, document_category, is_required, status, created_at
     from application_required_documents
     where id = $1
     limit 1`,
    [params.documentId]
  );
  return res.rows[0] ?? null;
}

export async function updateApplicationRequiredDocumentStatusById(params: {
  documentId: string;
  status: string;
  client?: Queryable;
}): Promise<ApplicationRequiredDocumentRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<ApplicationRequiredDocumentRecord>(
    `update application_required_documents
     set status = $1
     where id = $2
     returning id, application_id, document_category, is_required, status, created_at`,
    [params.status, params.documentId]
  );
  return res.rows[0] ?? null;
}

export async function createDocument(params: {
  applicationId: string;
  ownerUserId: string | null;
  title: string;
  documentType: string;
  filename?: string | null;
  storageKey?: string | null;
  uploadedBy?: string | null;
  client?: Queryable;
}): Promise<DocumentRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentRecord>(
    `insert into documents
     (id, application_id, owner_user_id, title, document_type, filename, storage_key, uploaded_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'client'), now(), now())
     returning id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at`,
    [
      randomUUID(),
      params.applicationId,
      params.ownerUserId,
      params.title,
      params.documentType,
      params.filename ?? null,
      params.storageKey ?? null,
      params.uploadedBy ?? null,
    ]
  );
  return requireRow(res.rows, "document");
}

export async function updateDocumentStatus(params: {
  documentId: string;
  status: string;
  rejectionReason?: string | null;
  client?: Queryable;
}): Promise<DocumentRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentRecord>(
    `update documents
     set status = $1,
         rejection_reason = $2,
         updated_at = now()
     where id = $3
     returning id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at`,
    [params.status, params.rejectionReason ?? null, params.documentId]
  );
  return res.rows[0] ?? null;
}

export async function updateDocumentUploadDetails(params: {
  documentId: string;
  status: string;
  filename?: string | null;
  storageKey?: string | null;
  uploadedBy?: string | null;
  client?: Queryable;
}): Promise<DocumentRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentRecord>(
    `update documents
     set status = $1,
         filename = $2,
         storage_key = $3,
         uploaded_by = coalesce($4, uploaded_by),
         updated_at = now()
     where id = $5
     returning id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at`,
    [
      params.status,
      params.filename ?? null,
      params.storageKey ?? null,
      params.uploadedBy ?? null,
      params.documentId,
    ]
  );
  return res.rows[0] ?? null;
}

export async function findDocumentById(
  id: string,
  client?: Queryable
): Promise<DocumentRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<DocumentRecord>(
    `select id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at
     from documents
     where id = $1
     limit 1`,
    [id]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function findDocumentByApplicationAndType(params: {
  applicationId: string;
  documentType: string;
  client?: Queryable;
}): Promise<DocumentRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentRecord>(
    `select id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at
     from documents
     where application_id = $1
       and document_type = $2
     limit 1`,
    [params.applicationId, params.documentType]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function listDocumentsByApplicationId(
  applicationId: string,
  client?: Queryable
): Promise<DocumentRecord[]> {
  const runner = client ?? pool;
  const res = await runner.query<DocumentRecord>(
    `select id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, rejection_reason, created_at, updated_at
     from documents
     where application_id = $1
     order by created_at asc`,
    [applicationId]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function listDocumentsWithLatestVersion(params: {
  applicationId: string;
  client?: Queryable;
}): Promise<
  Array<{
    id: string;
    application_id: string;
    owner_user_id: string | null;
    title: string;
    document_type: string;
    status: string;
    created_at: Date;
    filename: string | null;
    storage_key: string | null;
    uploaded_by: string;
    rejection_reason: string | null;
    updated_at: Date;
    version_id: string | null;
    version: number | null;
    metadata: unknown | null;
    review_status: string | null;
  }>
> {
  const runner = params.client ?? pool;
  const res = await runner.query<{
    id: string;
    application_id: string;
    owner_user_id: string | null;
    title: string;
    document_type: string;
    status: string;
    created_at: Date;
    filename: string | null;
    storage_key: string | null;
    uploaded_by: string;
    rejection_reason: string | null;
    updated_at: Date;
    version_id: string | null;
    version: number | null;
    metadata: unknown | null;
    review_status: string | null;
  }>(
    `select d.id,
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
     order by d.created_at asc`,
    [params.applicationId]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function deleteDocumentById(params: {
  documentId: string;
  client?: Queryable;
}): Promise<void> {
  const runner = params.client ?? pool;
  await runner.query(
    "delete from documents where id = $1",
    [params.documentId]
  );
}

export async function fetchLatestDocumentVersion(
  documentId: string,
  client?: Queryable
): Promise<number> {
  const runner = client ?? pool;
  const res = await runner.query<{ version: number }>(
    `select coalesce(max(version), 0) as version
     from document_versions
     where document_id = $1`,
    [documentId]
  );
  const first = res.rows[0];
  return Number(first?.version ?? 0);
}

export async function createDocumentVersion(params: {
  documentId: string;
  version: number;
  metadata: unknown;
  content: string;
  blobName?: string | null;
  hash?: string | null;
  client?: Queryable;
}): Promise<DocumentVersionRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentVersionRecord>(
    `insert into document_versions
     (id, document_id, version, blob_name, hash, metadata, content, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     returning id, document_id, version, blob_name, hash, metadata, content, created_at`,
    [
      randomUUID(),
      params.documentId,
      params.version,
      params.blobName ?? null,
      params.hash ?? null,
      params.metadata,
      params.content,
    ]
  );
  return requireRow(res.rows, "document version");
}

export async function findDocumentVersionById(
  id: string,
  client?: Queryable
): Promise<DocumentVersionRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<DocumentVersionRecord>(
    `select id, document_id, version, blob_name, hash, metadata, content, created_at
     from document_versions
     where id = $1
     limit 1`,
    [id]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function findDocumentVersionReview(
  documentVersionId: string,
  client?: Queryable
): Promise<DocumentVersionReviewRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<DocumentVersionReviewRecord>(
    `select id, document_version_id, status, reviewed_by_user_id, reviewed_at
     from document_version_reviews
     where document_version_id = $1
     limit 1`,
    [documentVersionId]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function findAcceptedDocumentVersion(params: {
  documentId: string;
  client?: Queryable;
}): Promise<DocumentVersionRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentVersionRecord>(
    `select dv.id, dv.document_id, dv.version, dv.blob_name, dv.hash, dv.metadata, dv.content, dv.created_at
     from document_versions dv
     join document_version_reviews r on r.document_version_id = dv.id
     where dv.document_id = $1
       and r.status = 'accepted'
     order by dv.version desc
     limit 1`,
    [params.documentId]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function createDocumentVersionReview(params: {
  documentVersionId: string;
  status: string;
  reviewedByUserId: string | null;
  client?: Queryable;
}): Promise<DocumentVersionReviewRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentVersionReviewRecord>(
    `insert into document_version_reviews
     (id, document_version_id, status, reviewed_by_user_id, reviewed_at)
     values ($1, $2, $3, $4, now())
     returning id, document_version_id, status, reviewed_by_user_id, reviewed_at`,
    [randomUUID(), params.documentVersionId, params.status, params.reviewedByUserId]
  );
  return requireRow(res.rows, "document version review");
}

export async function findLatestDocumentVersionStatus(params: {
  applicationId: string;
  documentType: string;
  client?: Queryable;
}): Promise<{
  document_id: string;
  document_type: string;
  version_id: string;
  version: number;
  status: string | null;
} | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<{
    document_id: string;
    document_type: string;
    version_id: string;
    version: number;
    status: string | null;
  }>(
    `select d.id as document_id,
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
     limit 1`,
    [params.applicationId, params.documentType]
  );
  const first = res.rows[0];
  return first ?? null;
}

export async function listLatestAcceptedDocumentVersions(params: {
  applicationId: string;
  documentTypes: string[];
  client?: Queryable;
}): Promise<
  Array<{
    document_id: string;
    document_type: string;
    title: string;
    version_id: string;
    version: number;
    metadata: unknown;
    content: string;
  }>
> {
  const runner = params.client ?? pool;
  const res = await runner.query<{
    document_id: string;
    document_type: string;
    title: string;
    version_id: string;
    version: number;
    metadata: unknown;
    content: string;
  }>(
    `select distinct on (d.document_type)
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
     order by d.document_type, dv.version desc`,
    [params.applicationId, params.documentTypes]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function findActiveDocumentVersion(params: {
  documentId: string;
  client?: Queryable;
}): Promise<DocumentVersionRecord | null> {
  const runner = params.client ?? pool;
  const accepted = await runner.query<DocumentVersionRecord>(
    `select dv.id, dv.document_id, dv.version, dv.blob_name, dv.hash, dv.metadata, dv.content, dv.created_at
     from document_versions dv
     join document_version_reviews r on r.document_version_id = dv.id
     where dv.document_id = $1
       and r.status = 'accepted'
     order by dv.version desc
     limit 1`,
    [params.documentId]
  );
  const acceptedRecord = accepted.rows[0];
  if (acceptedRecord) {
    return acceptedRecord;
  }
  const latest = await runner.query<DocumentVersionRecord>(
    `select id, document_id, version, blob_name, hash, metadata, content, created_at
     from document_versions
     where document_id = $1
     order by version desc
     limit 1`,
    [params.documentId]
  );
  const latestRecord = latest.rows[0];
  return latestRecord ?? null;
}
