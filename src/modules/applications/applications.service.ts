import { AppError } from "../../middleware/errors";
import { recordAuditEvent } from "../audit/audit.service";
import {
  createApplication,
  createApplicationStageEvent,
  createDocument,
  createDocumentVersion,
  createDocumentVersionReview,
  deleteDocumentById,
  findApplicationById,
  findDocumentById,
  findAcceptedDocumentVersion,
  findDocumentVersionById,
  findDocumentVersionReview,
  findActiveDocumentVersion,
  fetchLatestDocumentVersion,
  listApplicationRequiredDocuments,
  listDocumentsWithLatestVersion,
  updateApplicationFirstOpenedAt,
  updateApplicationPipelineState,
  upsertApplicationRequiredDocument,
  updateDocumentStatus,
  updateDocumentUploadDetails,
} from "./applications.repo";
import type {
  ApplicationRecord,
  ApplicationRequiredDocumentRecord,
} from "./applications.repo";
import { pool, runQuery } from "../../db";
import { type Role, ROLES } from "../../auth/roles";
import { type PoolClient } from "pg";
import {
  PIPELINE_STATES,
  ApplicationStage,
  isPipelineState,
  type PipelineState,
} from "./pipelineState";
import {
  assertPipelineState,
  assertPipelineTransition,
} from "./applicationLifecycle.service";
import { config } from "../../config";
import { recordTransactionRollback } from "../../observability/transactionTelemetry";
import { resolveRequirementsForApplication } from "../../services/lenderProductRequirementsService";
import { uploadDocumentBuffer } from "../../services/storage/blobStorage";
import { validateFile } from "../../utils/fileValidation";
import {
  normalizeRequiredDocumentKey,
} from "../../db/schema/requiredDocuments";
import { type ApplicationResponse, type ProcessingStatusResponse } from "./application.dto";
import {
  advanceProcessingStage,
  fetchProcessingStageFlags,
} from "./processingStage.service";
import {
  createBankingAnalysisJob,
  createDocumentProcessingJob,
} from "../processing/processing.service";

const BANK_STATEMENT_CATEGORY = "bank_statements_6_months";

const EMPTY_OCR_INSIGHTS: ApplicationResponse["ocrInsights"] = {
  fields: {},
  missingFields: [],
  conflictingFields: [],
  warnings: [],
  groupedByDocumentType: {},
  groupedByFieldCategory: {},
};

export type DocumentUploadResponse = {
  documentId: string;
  versionId: string;
  version: number;
};

type MetadataPayload = {
  fileName: string;
  mimeType: string;
  size: number;
};

export type DocumentSummary = {
  documentCategory: string;
  isRequired: boolean;
  status: string;
  documents: Array<{
    documentId: string;
    title: string;
    documentType: string;
    status: string;
    filename: string | null;
    storageKey: string | null;
    uploadedBy: string;
    rejectionReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    latestVersion: {
      id: string;
      version: number;
      metadata: unknown;
      reviewStatus: string | null;
    } | null;
  }>;
};

type IdempotentResult<T> = {
  status: number;
  value: T;
  idempotent: boolean;
};

type Queryable = Pick<PoolClient, "query" | "runQuery">;

function buildRequestMetadata(params: {
  ip?: string;
  userAgent?: string;
}): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (params.ip) {
    metadata.ip = params.ip;
  }
  if (params.userAgent) {
    metadata.userAgent = params.userAgent;
  }
  return metadata;
}

function resolveApplicationCountry(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const business = (metadata as { business?: unknown }).business;
  if (!business || typeof business !== "object") {
    return null;
  }
  const address = (business as { address?: unknown }).address;
  if (!address || typeof address !== "object") {
    return null;
  }
  const country = (address as { country?: unknown }).country;
  return typeof country === "string" && country.trim().length > 0
    ? country.trim()
    : null;
}

function toIsoString(value: Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.toISOString();
}

function normalizeDocumentStatus(status: string): DocumentStatus {
  return DOCUMENT_STATUS_VALUES.has(status as DocumentStatus)
    ? (status as DocumentStatus)
    : "missing";
}

const DEFAULT_PIPELINE_STAGE = ApplicationStage.RECEIVED;
const STAFF_REVIEW_ROLES: ReadonlySet<Role> = new Set([
  ROLES.ADMIN,
  ROLES.STAFF,
  ROLES.OPS,
]);

const DOCUMENT_STATUS_VALUES = new Set([
  "missing",
  "uploaded",
  "accepted",
  "rejected",
] as const);

type DocumentStatus = "missing" | "uploaded" | "accepted" | "rejected";

function normalizePipelineStage(stage: string | null): string {
  return stage ?? DEFAULT_PIPELINE_STAGE;
}

function assertMetadata(value: unknown): asserts value is MetadataPayload {
  if (!value || typeof value !== "object") {
    throw new AppError("invalid_metadata", "Metadata is required.", 400);
  }
  const record = value as Partial<MetadataPayload>;
  if (
    typeof record.fileName !== "string" ||
    typeof record.mimeType !== "string" ||
    typeof record.size !== "number"
  ) {
    throw new AppError("invalid_metadata", "Metadata is invalid.", 400);
  }
}

function validateDocumentMetadata(metadata: MetadataPayload): void {
  const allowed = config.documents.allowedMimeTypes;
  if (!allowed.includes(metadata.mimeType)) {
    throw new AppError("invalid_mime_type", "Unsupported document MIME type.", 400);
  }
  const maxSize = config.documents.maxSizeBytes;
  if (metadata.size > maxSize) {
    throw new AppError("document_too_large", "Document exceeds max size.", 400);
  }
}

async function recordDocumentUploadFailure(params: {
  actorUserId: string;
  targetUserId: string | null;
  ip?: string;
  userAgent?: string;
  client?: Queryable;
}): Promise<void> {
  const auditPayload = {
    action: "document_upload_rejected",
    actorUserId: params.actorUserId,
    targetUserId: params.targetUserId,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
    success: false,
    ...(params.client ? { client: params.client } : {}),
  };
  await recordAuditEvent(auditPayload);
}

function canAccessApplication(
  role: Role,
  ownerUserId: string | null,
  actorId: string
): boolean {
  if (ownerUserId && actorId === ownerUserId) {
    return true;
  }
  return role === ROLES.ADMIN || role === ROLES.STAFF;
}

function resolveUploadedBy(role: Role): "client" | "staff" {
  return STAFF_REVIEW_ROLES.has(role) ? "staff" : "client";
}

function assertStaffReviewRole(role: Role): void {
  if (!STAFF_REVIEW_ROLES.has(role)) {
    throw new AppError("forbidden", "Not authorized.", 403);
  }
}

async function ensureRequiredDocuments(params: {
  application: ApplicationRecord;
  requirements: Array<{ documentType: string; required: boolean }>;
  client?: Queryable;
}): Promise<ApplicationRequiredDocumentRecord[]> {
  const existing = await listApplicationRequiredDocuments({
    applicationId: params.application.id,
    ...(params.client ? { client: params.client } : {}),
  });

  const existingMap = new Map(
    existing.map((entry) => [entry.document_category, entry])
  );

  return params.requirements.map((requirement) => {
    const key = normalizeRequiredDocumentKey(requirement.documentType);
    const documentCategory = key ?? requirement.documentType;
    const match = existingMap.get(documentCategory);
    if (match) {
      return match;
    }
    return {
      id: `missing-${documentCategory}`,
      application_id: params.application.id,
      document_category: documentCategory,
      is_required: requirement.required !== false,
      status: "missing",
      created_at: new Date(0),
    };
  });
}

async function resolveRequirementForDocument(params: {
  application: ApplicationRecord;
  documentType: string;
  client?: Queryable;
}): Promise<{ documentCategory: string; isRequired: boolean }> {
  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: params.application.lender_product_id ?? null,
    productType: params.application.product_type,
    requestedAmount: params.application.requested_amount ?? null,
    country: resolveApplicationCountry(params.application.metadata),
  });
  const normalizedRequested = normalizeRequiredDocumentKey(params.documentType);
  const requirement = requirements.find((item) => {
    const normalizedRequirement = normalizeRequiredDocumentKey(item.documentType);
    return normalizedRequirement && normalizedRequested
      ? normalizedRequirement === normalizedRequested
      : item.documentType === params.documentType;
  });

  return {
    documentCategory: normalizedRequested ?? params.documentType,
    isRequired: requirement?.required !== false,
  };
}

async function enforceDocumentsRequiredStage(params: {
  application: ApplicationRecord;
  actorUserId: string | null;
  actorRole: Role | null;
  trigger: string;
  client?: Queryable;
}): Promise<void> {
  if (params.application.pipeline_state !== ApplicationStage.DOCUMENTS_REQUIRED) {
    await transitionPipelineState({
      applicationId: params.application.id,
      nextState: ApplicationStage.DOCUMENTS_REQUIRED,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      trigger: params.trigger,
      ...(params.client ? { client: params.client } : {}),
    });
    return;
  }
}

export async function transitionPipelineState(params: {
  applicationId: string;
  nextState: PipelineState;
  actorUserId: string | null;
  actorRole: Role | null;
  trigger: string;
  reason?: string | null;
  ip?: string;
  userAgent?: string;
  client?: Queryable;
}): Promise<void> {
  const application = await findApplicationById(
    params.applicationId,
    params.client
  );
  if (!application) {
    const auditPayload = {
      action: "pipeline_state_changed",
      actorUserId: params.actorUserId,
      targetUserId: null,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
      ...(params.client ? { client: params.client } : {}),
    };
    await recordAuditEvent(auditPayload);
    throw new AppError("not_found", "Application not found.", 404);
  }

  if (params.actorUserId && params.actorRole) {
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      const auditPayload = {
        action: "pipeline_state_changed",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: false,
        ...(params.client ? { client: params.client } : {}),
      };
      await recordAuditEvent(auditPayload);
      throw new AppError("forbidden", "Not authorized.", 403);
    }
  }

  const currentStage = assertPipelineState(application.pipeline_state);
  let transition;
  try {
    transition = assertPipelineTransition({
      currentStage,
      nextStage: params.nextState,
    });
  } catch (error) {
    const auditPayload = {
      action: "pipeline_state_changed",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
      ...(params.client ? { client: params.client } : {}),
    };
    await recordAuditEvent(auditPayload);
    throw error;
  }
  if (!transition.shouldTransition) {
    return;
  }

  await updateApplicationPipelineState({
    applicationId: params.applicationId,
    pipelineState: params.nextState,
    ...(params.client ? { client: params.client } : {}),
  });
  await createApplicationStageEvent({
    applicationId: params.applicationId,
    fromStage: currentStage,
    toStage: params.nextState,
    trigger: params.trigger,
    triggeredBy: params.actorUserId ?? "system",
    reason: params.reason ?? null,
    ...(params.client ? { client: params.client } : {}),
  });
  const auditSuccessPayload = {
    action: "pipeline_state_changed",
    actorUserId: params.actorUserId,
    targetUserId: application.owner_user_id,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
    success: true,
    ...(params.client ? { client: params.client } : {}),
  };
  await recordAuditEvent(auditSuccessPayload);
  const auditStagePayload = {
    action: "pipeline_stage_changed",
    actorUserId: params.actorUserId,
    targetUserId: application.owner_user_id,
    targetType: "application",
    targetId: params.applicationId,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
    success: true,
    metadata: {
      from: currentStage,
      to: params.nextState,
    },
    ...(params.client ? { client: params.client } : {}),
  };
  await recordAuditEvent(auditStagePayload);
}

async function evaluateRequirements(params: {
  applicationId: string;
  actorUserId: string | null;
  actorRole: Role | null;
  ip?: string;
  userAgent?: string;
  client?: Queryable;
}): Promise<{ missingRequired: boolean }> {
  const application = await findApplicationById(
    params.applicationId,
    params.client
  );
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }
  if (!isPipelineState(application.pipeline_state)) {
    throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
  }
  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: application.lender_product_id ?? null,
    productType: application.product_type,
    requestedAmount: application.requested_amount ?? null,
    country: resolveApplicationCountry(application.metadata),
  });

  const requiredDocuments = await ensureRequiredDocuments({
    application,
    requirements,
    ...(params.client ? { client: params.client } : {}),
  });

  const missingRequired = requiredDocuments.some((doc) => {
    if (!doc.is_required) {
      return false;
    }
    return doc.status !== "accepted";
  });

  if (missingRequired && application.pipeline_state === ApplicationStage.RECEIVED) {
    await transitionPipelineState({
      applicationId: application.id,
      nextState: ApplicationStage.DOCUMENTS_REQUIRED,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      trigger: "requirements_missing",
      ...(params.ip ? { ip: params.ip } : {}),
      ...(params.userAgent ? { userAgent: params.userAgent } : {}),
      ...(params.client ? { client: params.client } : {}),
    });
  }

  return { missingRequired };
}

export async function createApplicationForUser(params: {
  ownerUserId: string;
  name: string;
  metadata: unknown | null;
  productType?: string | null;
  actorUserId: string | null;
  actorRole?: Role | null;
  ip?: string;
  userAgent?: string;
}): Promise<IdempotentResult<ApplicationResponse>> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    await client.runQuery("select id from users where id = $1 for update", [
      params.ownerUserId,
    ]);

    const application = await createApplication({
      ownerUserId: params.ownerUserId,
      name: params.name,
      metadata: params.metadata,
      productType: params.productType ?? "standard",
      trigger: "application_created",
      triggeredBy: params.actorUserId ?? "system",
      client,
    });
    await recordAuditEvent({
      action: "application_created",
      actorUserId: params.actorUserId,
      targetUserId: params.ownerUserId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });

    await evaluateRequirements({
      applicationId: application.id,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole ?? (params.actorUserId ? ROLES.REFERRER : null),
      ...buildRequestMetadata(params),
      client,
    });

    const updated = await findApplicationById(application.id, client);
    if (!updated) {
      throw new AppError("not_found", "Application not found.", 404);
    }

    const response: ApplicationResponse = {
      id: updated.id,
      ownerUserId: updated.owner_user_id,
      name: updated.name,
      metadata: updated.metadata,
      productType: updated.product_type,
      pipelineState: normalizePipelineStage(updated.pipeline_state),
      lenderId: updated.lender_id ?? null,
      lenderProductId: updated.lender_product_id ?? null,
      requestedAmount: updated.requested_amount ?? null,
      createdAt: updated.created_at,
      updatedAt: updated.updated_at,
      ocrInsights: EMPTY_OCR_INSIGHTS,
    };

    await client.runQuery("commit");
    return { status: 201, value: response, idempotent: false };
  } catch (err) {
    recordTransactionRollback(err);
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function openApplicationForStaff(params: {
  applicationId: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  if (params.actorRole !== ROLES.ADMIN && params.actorRole !== ROLES.STAFF) {
    throw new AppError("forbidden", "Not authorized.", 403);
  }
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const application = await findApplicationById(params.applicationId, client);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }
    if (!isPipelineState(application.pipeline_state)) {
      throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
    }

    const didOpen = await updateApplicationFirstOpenedAt({
      applicationId: params.applicationId,
      client,
    });

    if (didOpen && application.pipeline_state === ApplicationStage.RECEIVED) {
      await transitionPipelineState({
        applicationId: params.applicationId,
        nextState: ApplicationStage.IN_REVIEW,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        trigger: "first_opened",
        ...buildRequestMetadata(params),
        client,
      });
    }

    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function listDocumentsForApplication(params: {
  applicationId: string;
  actorUserId: string;
  actorRole: Role;
}): Promise<DocumentSummary[]> {
  const application = await findApplicationById(params.applicationId);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }
  if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
    throw new AppError("forbidden", "Not authorized.", 403);
  }

  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: application.lender_product_id ?? null,
    productType: application.product_type,
    requestedAmount: application.requested_amount ?? null,
    country: resolveApplicationCountry(application.metadata),
  });

  const requiredDocuments = await ensureRequiredDocuments({
    application,
    requirements,
  });

  const documents = await listDocumentsWithLatestVersion({
    applicationId: params.applicationId,
  });

  const grouped = new Map<string, DocumentSummary>();

  for (const requirement of requiredDocuments) {
    grouped.set(requirement.document_category, {
      documentCategory: requirement.document_category,
      isRequired: requirement.is_required,
      status: requirement.status,
      documents: [],
    });
  }

  for (const doc of documents) {
    const existing =
      grouped.get(doc.document_type) ??
      {
        documentCategory: doc.document_type,
        isRequired: false,
        status: "uploaded",
        documents: [],
      };
    existing.documents.push({
      documentId: doc.id,
      title: doc.title,
      documentType: doc.document_type,
      status: doc.status,
      filename: doc.filename ?? null,
      storageKey: doc.storage_key ?? null,
      uploadedBy: doc.uploaded_by,
      rejectionReason: doc.rejection_reason ?? null,
      createdAt: doc.created_at,
      updatedAt: doc.updated_at,
      latestVersion:
        doc.version_id && doc.version !== null
          ? {
              id: doc.version_id,
              version: doc.version,
              metadata: doc.metadata ?? null,
              reviewStatus: doc.review_status ?? null,
            }
          : null,
    });
    grouped.set(doc.document_type, existing);
  }

  return Array.from(grouped.values()).sort((a, b) =>
    a.documentCategory.localeCompare(b.documentCategory)
  );
}

export async function fetchProcessingStatus(
  applicationId: string
): Promise<ProcessingStatusResponse> {
  const application = await findApplicationById(applicationId);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }

  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: application.lender_product_id ?? null,
    productType: application.product_type,
    requestedAmount: application.requested_amount ?? null,
    country: resolveApplicationCountry(application.metadata),
  });

  const requiredDocuments = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.required === false) {
      continue;
    }
    const normalized = normalizeRequiredDocumentKey(requirement.documentType);
    if (normalized) {
      requiredDocuments.add(normalized);
    }
  }

  const requiredEntries = await listApplicationRequiredDocuments({ applicationId });
  const requiredMap: ProcessingStatusResponse["status"]["documents"]["required"] = {};

  for (const key of requiredDocuments) {
    requiredMap[key] = { status: "missing", updatedAt: null };
  }

  for (const entry of requiredEntries) {
    if (!entry.is_required) {
      continue;
    }
    const normalized = normalizeRequiredDocumentKey(entry.document_category);
    if (!normalized) {
      continue;
    }
    requiredDocuments.add(normalized);
    requiredMap[normalized] = {
      status: normalizeDocumentStatus(entry.status),
      updatedAt: toIsoString(entry.created_at),
    };
  }

  const allAccepted = Object.values(requiredMap).every(
    (document) => document.status === "accepted"
  );
  const stageFlags = fetchProcessingStageFlags(application.processing_stage);

  return {
    applicationId: application.id,
    status: {
      ocr: {
        completed: stageFlags.ocrCompleted,
        completedAt: stageFlags.ocrCompleted
          ? toIsoString(application.ocr_completed_at)
          : null,
      },
      banking: {
        completed: stageFlags.bankingCompleted,
        completedAt: stageFlags.bankingCompleted
          ? toIsoString(application.banking_completed_at)
          : null,
      },
      documents: {
        required: requiredMap,
        allAccepted,
      },
      creditSummary: {
        completed: stageFlags.creditSummaryCompleted,
        completedAt: stageFlags.creditSummaryCompleted
          ? toIsoString(application.credit_summary_completed_at)
          : null,
      },
    },
  };
}

export async function removeDocument(params: {
  applicationId: string;
  documentId: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const application = await findApplicationById(params.applicationId, client);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }
    if (!isPipelineState(application.pipeline_state)) {
      throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
    }

    const document = await findDocumentById(params.documentId, client);
    if (!document || document.application_id !== params.applicationId) {
      throw new AppError("not_found", "Document not found.", 404);
    }
    await deleteDocumentById({ documentId: params.documentId, client });

    await recordAuditEvent({
      action: "document_deleted",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      targetType: "document",
      targetId: params.documentId,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });

    const evaluation = await evaluateRequirements({
      applicationId: params.applicationId,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      ...buildRequestMetadata(params),
      client,
    });

    if (
      evaluation.missingRequired &&
      application.pipeline_state !== ApplicationStage.DOCUMENTS_REQUIRED
    ) {
      await transitionPipelineState({
        applicationId: params.applicationId,
        nextState: ApplicationStage.DOCUMENTS_REQUIRED,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        trigger: "requirements_missing",
        ...buildRequestMetadata(params),
        client,
      });
    }

    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function markCreditSummaryCompleted(params: {
  applicationId: string;
  client?: Queryable;
}): Promise<void> {
  if (params.client) {
    await params.client.runQuery(
      `update applications
       set credit_summary_completed_at = now(),
           updated_at = now()
       where id = $1`,
      [params.applicationId]
    );
    await advanceProcessingStage({
      applicationId: params.applicationId,
      client: params.client,
    });
    return;
  }

  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    await client.runQuery(
      `update applications
       set credit_summary_completed_at = now(),
           updated_at = now()
       where id = $1`,
      [params.applicationId]
    );
    await advanceProcessingStage({
      applicationId: params.applicationId,
      client,
    });
    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function uploadDocument(params: {
  applicationId: string;
  documentId?: string | null;
  title: string;
  documentType?: string | null;
  metadata: unknown;
  content: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<IdempotentResult<DocumentUploadResponse>> {
  assertMetadata(params.metadata);
  try {
    validateDocumentMetadata(params.metadata);
  } catch (err) {
    await recordDocumentUploadFailure({
      actorUserId: params.actorUserId,
      targetUserId: null,
      ...buildRequestMetadata(params),
    });
    throw err;
  }

  const application = await findApplicationById(params.applicationId);
  if (!application) {
    await recordAuditEvent({
      action: "document_uploaded",
      actorUserId: params.actorUserId,
      targetUserId: null,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
    });
    throw new AppError("not_found", "Application not found.", 404);
  }

  if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
    await recordAuditEvent({
      action: "document_uploaded",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: false,
    });
    throw new AppError("forbidden", "Not authorized.", 403);
  }

  if (!isPipelineState(application.pipeline_state)) {
    throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
  }
  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: application.lender_product_id ?? null,
    productType: application.product_type,
    requestedAmount: application.requested_amount ?? null,
    country: resolveApplicationCountry(application.metadata),
  });
  const requestedType = params.documentType ?? params.title;
  const normalizedRequested = normalizeRequiredDocumentKey(requestedType);
  const requirement = requirements.find((item) => {
    const normalizedRequirement = normalizeRequiredDocumentKey(item.documentType);
    return normalizedRequirement && normalizedRequested
      ? normalizedRequirement === normalizedRequested
      : item.documentType === requestedType;
  });
  if (!requirement && !normalizedRequested) {
    await recordDocumentUploadFailure({
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ...buildRequestMetadata(params),
    });
    throw new AppError("invalid_document_type", "Document type is not allowed.", 400);
  }
  const buffer = Buffer.from(params.content, "base64");
  const detectedType = await validateFile(buffer);
  const uploaded = await uploadDocumentBuffer({
    buffer,
    filename: params.metadata.fileName,
    contentType: detectedType.mime,
  });

  const normalizedCategory = normalizedRequested ?? requestedType;

  const client = await pool.connect();
  let documentId: string | null = params.documentId ?? null;
  let isNewDocument = false;
  try {
    await client.runQuery("begin");
    if (documentId) {
      const existingDoc = await findDocumentById(documentId, client);
      if (!existingDoc || existingDoc.application_id !== params.applicationId) {
        await client.runQuery("rollback");
        throw new AppError("not_found", "Document not found.", 404);
      }
      const incomingType = params.documentType ?? existingDoc.document_type;
      const normalizedExisting = normalizeRequiredDocumentKey(existingDoc.document_type);
      const normalizedIncoming = normalizeRequiredDocumentKey(incomingType);
      if (
        normalizedExisting &&
        normalizedIncoming
          ? normalizedExisting !== normalizedIncoming
          : existingDoc.document_type !== incomingType
      ) {
        await recordDocumentUploadFailure({
          actorUserId: params.actorUserId,
          targetUserId: application.owner_user_id,
          ...buildRequestMetadata(params),
          client,
        });
        throw new AppError("document_type_mismatch", "Document type mismatch.", 400);
      }
      const accepted = await findAcceptedDocumentVersion({
        documentId,
        client,
      });
      if (accepted) {
        await recordDocumentUploadFailure({
          actorUserId: params.actorUserId,
          targetUserId: application.owner_user_id,
          ...buildRequestMetadata(params),
          client,
        });
        throw new AppError(
          "document_immutable",
          "Accepted document versions cannot be modified.",
          409
        );
      }
    } else {
      const doc = await createDocument({
        applicationId: params.applicationId,
        ownerUserId: application.owner_user_id,
        title: params.title,
        documentType: params.documentType ?? params.title,
        filename: params.metadata.fileName,
        storageKey: uploaded.blobName,
        uploadedBy: resolveUploadedBy(params.actorRole),
        client,
      });
      documentId = doc.id;
      isNewDocument = true;
    }

    const currentVersion = await fetchLatestDocumentVersion(documentId, client);
    const nextVersion = currentVersion + 1;
    if (nextVersion <= currentVersion) {
      await client.runQuery("rollback");
      throw new AppError("version_conflict", "Invalid document version.", 409);
    }

    const version = await createDocumentVersion({
      documentId,
      version: nextVersion,
      blobName: uploaded.blobName,
      hash: uploaded.hash,
      metadata: {
        ...(params.metadata as Record<string, unknown>),
        mimeType: detectedType.mime,
        storageKey: uploaded.blobName,
        storageUrl: uploaded.url,
        hash: uploaded.hash,
      },
      content: "",
      client,
    });

    await recordAuditEvent({
      action: "document_uploaded",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });
    await updateDocumentUploadDetails({
      documentId,
      status: "uploaded",
      filename: params.metadata.fileName,
      storageKey: uploaded.blobName,
      uploadedBy: resolveUploadedBy(params.actorRole),
      client,
    });
    await upsertApplicationRequiredDocument({
      applicationId: params.applicationId,
      documentCategory: normalizedCategory,
      isRequired: requirement?.required === true,
      status: "uploaded",
      client,
    });

    const response: DocumentUploadResponse = {
      documentId,
      versionId: version.id,
      version: version.version,
    };

    await client.runQuery("commit");
    if (isNewDocument) {
      if (normalizedCategory === BANK_STATEMENT_CATEGORY) {
        await createBankingAnalysisJob(params.applicationId);
      } else {
        await createDocumentProcessingJob(params.applicationId, documentId);
      }
    }

    return { status: 201, value: response, idempotent: false };
  } catch (err) {
    recordTransactionRollback(err);
    try {
      await client.runQuery("rollback");
    } catch {
      // ignore rollback
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function changePipelineState(params: {
  applicationId: string;
  nextState: string;
  override?: boolean;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  const requestedState = params.nextState.trim().toUpperCase();
  const isDeclinedAlias = requestedState === "DECLINED";
  if (!isDeclinedAlias && !isPipelineState(requestedState)) {
    throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
  }

  const application = await findApplicationById(params.applicationId);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }

  if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
    throw new AppError("forbidden", "Not authorized.", 403);
  }

  const currentStage = assertPipelineState(application.pipeline_state);
  const nextStage = isDeclinedAlias ? "DECLINED" : requestedState;

  if (
    !params.override &&
    (currentStage === ApplicationStage.RECEIVED ||
      currentStage === ApplicationStage.DOCUMENTS_REQUIRED) &&
    nextStage === ApplicationStage.OFF_TO_LENDER
  ) {
    throw new AppError("invalid_transition", "Invalid pipeline transition.", 400);
  }

  if (currentStage === nextStage) {
    return;
  }

  await updateApplicationPipelineState({
    applicationId: params.applicationId,
    pipelineState: nextStage,
  });
  await createApplicationStageEvent({
    applicationId: params.applicationId,
    fromStage: currentStage,
    toStage: nextStage,
    trigger: params.override ? "manual_override" : "manual_change",
    triggeredBy: params.actorUserId,
    reason: params.override ? "override" : null,
  });
  await recordAuditEvent({
    action: "pipeline_state_changed",
    actorUserId: params.actorUserId,
    targetUserId: application.owner_user_id,
    ip: params.ip ?? null,
    userAgent: params.userAgent ?? null,
    success: true,
    metadata: { from: currentStage, to: nextStage, override: params.override === true },
  });
}

export async function acceptDocumentVersion(params: {
  applicationId: string;
  documentId: string;
  documentVersionId: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  assertStaffReviewRole(params.actorRole);
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const application = await findApplicationById(params.applicationId, client);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }
    if (
      application.pipeline_state !== ApplicationStage.DOCUMENTS_REQUIRED &&
      application.pipeline_state !== ApplicationStage.RECEIVED
    ) {
      throw new AppError(
        "invalid_state",
        "Documents can only be reviewed while in DOCUMENTS_REQUIRED.",
        400
      );
    }

    const document = await findDocumentById(params.documentId, client);
    if (!document || document.application_id !== params.applicationId) {
      throw new AppError("not_found", "Document not found.", 404);
    }
    await client.runQuery("select id from document_versions where id = $1 for update", [
      params.documentVersionId,
    ]);
    const version = await findDocumentVersionById(params.documentVersionId, client);
    if (!version || version.document_id !== params.documentId) {
      throw new AppError("not_found", "Document version not found.", 404);
    }
    const review = await findDocumentVersionReview(params.documentVersionId, client);
    if (review) {
      throw new AppError("version_reviewed", "Document version already reviewed.", 409);
    }

    try {
      await createDocumentVersionReview({
        documentVersionId: params.documentVersionId,
        status: "accepted",
        reviewedByUserId: params.actorUserId,
        client,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("version_reviewed", "Document version already reviewed.", 409);
      }
      throw error;
    }

    await recordAuditEvent({
      action: "document_accepted",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });
    const requirement = await resolveRequirementForDocument({
      application,
      documentType: document.document_type,
      client,
    });
    await updateDocumentStatus({
      documentId: params.documentId,
      status: "accepted",
      rejectionReason: null,
      client,
    });
    await upsertApplicationRequiredDocument({
      applicationId: params.applicationId,
      documentCategory: requirement.documentCategory,
      isRequired: requirement.isRequired,
      status: "accepted",
      client,
    });

    const requiredDocuments = await listApplicationRequiredDocuments({
      applicationId: params.applicationId,
      client,
    });
    const hasPendingDocuments = requiredDocuments.some(
      (doc) => doc.status !== "accepted"
    );
    if (!hasPendingDocuments && application.pipeline_state === ApplicationStage.DOCUMENTS_REQUIRED) {
      await updateApplicationPipelineState({
        applicationId: params.applicationId,
        pipelineState: ApplicationStage.IN_REVIEW,
        client,
      });
      await createApplicationStageEvent({
        applicationId: params.applicationId,
        fromStage: ApplicationStage.DOCUMENTS_REQUIRED,
        toStage: ApplicationStage.IN_REVIEW,
        trigger: "requirements_satisfied",
        triggeredBy: params.actorUserId,
        client,
      });
      await recordAuditEvent({
        action: "pipeline_state_changed",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        client,
      });
      await recordAuditEvent({
        action: "pipeline_stage_changed",
        actorUserId: params.actorUserId,
        targetUserId: application.owner_user_id,
        targetType: "application",
        targetId: params.applicationId,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
          from: ApplicationStage.DOCUMENTS_REQUIRED,
          to: ApplicationStage.IN_REVIEW,
        },
        client,
      });
    }

    await advanceProcessingStage({
      applicationId: params.applicationId,
      client,
    });

    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectDocumentVersion(params: {
  applicationId: string;
  documentId: string;
  documentVersionId: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  assertStaffReviewRole(params.actorRole);
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const application = await findApplicationById(params.applicationId, client);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }
    if (
      application.pipeline_state !== ApplicationStage.DOCUMENTS_REQUIRED &&
      application.pipeline_state !== ApplicationStage.RECEIVED
    ) {
      throw new AppError(
        "invalid_state",
        "Documents can only be reviewed while in DOCUMENTS_REQUIRED.",
        400
      );
    }

    const document = await findDocumentById(params.documentId, client);
    if (!document || document.application_id !== params.applicationId) {
      throw new AppError("not_found", "Document not found.", 404);
    }
    const requirement = await resolveRequirementForDocument({
      application,
      documentType: document.document_type,
      client,
    });
    await client.runQuery("select id from document_versions where id = $1 for update", [
      params.documentVersionId,
    ]);
    const version = await findDocumentVersionById(params.documentVersionId, client);
    if (!version || version.document_id !== params.documentId) {
      throw new AppError("not_found", "Document version not found.", 404);
    }
    const review = await findDocumentVersionReview(params.documentVersionId, client);
    if (review) {
      throw new AppError("version_reviewed", "Document version already reviewed.", 409);
    }

    try {
      await createDocumentVersionReview({
        documentVersionId: params.documentVersionId,
        status: "rejected",
        reviewedByUserId: params.actorUserId,
        client,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError("version_reviewed", "Document version already reviewed.", 409);
      }
      throw error;
    }

    await recordAuditEvent({
      action: "document_rejected",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });
    await updateDocumentStatus({
      documentId: params.documentId,
      status: "rejected",
      rejectionReason: null,
      client,
    });
    await upsertApplicationRequiredDocument({
      applicationId: params.applicationId,
      documentCategory: requirement.documentCategory,
      isRequired: requirement.isRequired,
      status: "rejected",
      client,
    });

    await enforceDocumentsRequiredStage({
      application,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      trigger: "document_rejected",
      client,
    });

    await advanceProcessingStage({
      applicationId: params.applicationId,
      client,
    });

    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function acceptDocument(params: {
  documentId: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  assertStaffReviewRole(params.actorRole);
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const document = await findDocumentById(params.documentId, client);
    if (!document) {
      throw new AppError("not_found", "Document not found.", 404);
    }
    const application = await findApplicationById(document.application_id, client);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    const requirement = await resolveRequirementForDocument({
      application,
      documentType: document.document_type,
      client,
    });
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }

    const version = await findActiveDocumentVersion({ documentId: params.documentId, client });
    if (!version) {
      throw new AppError("not_found", "Document version not found.", 404);
    }
    const review = await findDocumentVersionReview(version.id, client);
    if (review) {
      throw new AppError("version_reviewed", "Document version already reviewed.", 409);
    }

    await createDocumentVersionReview({
      documentVersionId: version.id,
      status: "accepted",
      reviewedByUserId: params.actorUserId,
      client,
    });

    await recordAuditEvent({
      action: "document_accepted",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });

    await updateDocumentStatus({
      documentId: params.documentId,
      status: "accepted",
      rejectionReason: null,
      client,
    });
    await upsertApplicationRequiredDocument({
      applicationId: application.id,
      documentCategory: requirement.documentCategory,
      isRequired: requirement.isRequired,
      status: "accepted",
      client,
    });

    await advanceProcessingStage({
      applicationId: application.id,
      client,
    });

    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectDocument(params: {
  documentId: string;
  rejectionReason: string;
  actorUserId: string;
  actorRole: Role;
  ip?: string;
  userAgent?: string;
}): Promise<void> {
  assertStaffReviewRole(params.actorRole);
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const document = await findDocumentById(params.documentId, client);
    if (!document) {
      throw new AppError("not_found", "Document not found.", 404);
    }
    const application = await findApplicationById(document.application_id, client);
    if (!application) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    const requirement = await resolveRequirementForDocument({
      application,
      documentType: document.document_type,
      client,
    });
    if (!canAccessApplication(params.actorRole, application.owner_user_id, params.actorUserId)) {
      throw new AppError("forbidden", "Not authorized.", 403);
    }

    const version = await findActiveDocumentVersion({ documentId: params.documentId, client });
    if (!version) {
      throw new AppError("not_found", "Document version not found.", 404);
    }
    const review = await findDocumentVersionReview(version.id, client);
    if (review) {
      throw new AppError("version_reviewed", "Document version already reviewed.", 409);
    }

    await createDocumentVersionReview({
      documentVersionId: version.id,
      status: "rejected",
      reviewedByUserId: params.actorUserId,
      client,
    });

    await recordAuditEvent({
      action: "document_rejected",
      actorUserId: params.actorUserId,
      targetUserId: application.owner_user_id,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      success: true,
      client,
    });

    await updateDocumentStatus({
      documentId: params.documentId,
      status: "rejected",
      rejectionReason: params.rejectionReason,
      client,
    });
    await upsertApplicationRequiredDocument({
      applicationId: application.id,
      documentCategory: requirement.documentCategory,
      isRequired: requirement.isRequired,
      status: "rejected",
      client,
    });

    await enforceDocumentsRequiredStage({
      application,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      trigger: "document_rejected",
      client,
    });

    await advanceProcessingStage({
      applicationId: application.id,
      client,
    });

    await client.runQuery("commit");
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export function fetchPipelineStates(): string[] {
  return [...PIPELINE_STATES];
}
