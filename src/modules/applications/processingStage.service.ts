import { pool, runQuery } from "../../db";
import { AppError } from "../../middleware/errors";
import { resolveRequirementsForApplication } from "../../services/lenderProductRequirementsService";
import { normalizeRequiredDocumentKey } from "../../db/schema/requiredDocuments";
import { listApplicationRequiredDocuments } from "./applications.repo";
import type { PoolClient } from "pg";
import { ensureCreditSummaryJob } from "../processing/creditSummary.service";

export const PROCESSING_STAGES = [
  "pending",
  "ocr_processing",
  "ocr_complete",
  "banking_processing",
  "banking_complete",
  "documents_incomplete",
  "documents_complete",
  "credit_summary_processing",
  "credit_summary_complete",
  "ready_for_lender",
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

type Queryable = Pick<PoolClient, "query" | "runQuery">;

type ProcessingStageFlags = {
  ocrCompleted: boolean;
  bankingCompleted: boolean;
  documentsCompleted: boolean;
  creditSummaryCompleted: boolean;
};

const PROCESSING_STAGE_FLAGS: Record<ProcessingStage, ProcessingStageFlags> = {
  pending: {
    ocrCompleted: false,
    bankingCompleted: false,
    documentsCompleted: false,
    creditSummaryCompleted: false,
  },
  ocr_processing: {
    ocrCompleted: false,
    bankingCompleted: false,
    documentsCompleted: false,
    creditSummaryCompleted: false,
  },
  ocr_complete: {
    ocrCompleted: true,
    bankingCompleted: false,
    documentsCompleted: false,
    creditSummaryCompleted: false,
  },
  banking_processing: {
    ocrCompleted: true,
    bankingCompleted: false,
    documentsCompleted: false,
    creditSummaryCompleted: false,
  },
  banking_complete: {
    ocrCompleted: true,
    bankingCompleted: true,
    documentsCompleted: false,
    creditSummaryCompleted: false,
  },
  documents_incomplete: {
    ocrCompleted: true,
    bankingCompleted: true,
    documentsCompleted: false,
    creditSummaryCompleted: false,
  },
  documents_complete: {
    ocrCompleted: true,
    bankingCompleted: true,
    documentsCompleted: true,
    creditSummaryCompleted: false,
  },
  credit_summary_processing: {
    ocrCompleted: true,
    bankingCompleted: true,
    documentsCompleted: true,
    creditSummaryCompleted: false,
  },
  credit_summary_complete: {
    ocrCompleted: true,
    bankingCompleted: true,
    documentsCompleted: true,
    creditSummaryCompleted: true,
  },
  ready_for_lender: {
    ocrCompleted: true,
    bankingCompleted: true,
    documentsCompleted: true,
    creditSummaryCompleted: true,
  },
};

type DocumentStatusSummary = {
  allAccepted: boolean;
  anyRejected: boolean;
};

type ProcessingStageData = {
  ocrCompleted: boolean;
  bankingCompleted: boolean;
  creditSummaryCompleted: boolean;
  hasOcrJobsPending: boolean;
  hasBankingJobsPending: boolean;
  allDocumentsAccepted: boolean;
  anyDocumentsRejected: boolean;
};

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

export function isProcessingStage(value: string): value is ProcessingStage {
  return (PROCESSING_STAGES as readonly string[]).includes(value);
}

export function normalizeProcessingStage(value: string | null): ProcessingStage {
  if (value && isProcessingStage(value)) {
    return value;
  }
  return "pending";
}

export function fetchProcessingStageFlags(stage: string | null): ProcessingStageFlags {
  const normalized = normalizeProcessingStage(stage);
  return PROCESSING_STAGE_FLAGS[normalized];
}

async function fetchDocumentStatusSummary(params: {
  applicationId: string;
  productType: string;
  lenderProductId: string | null;
  requestedAmount: number | null;
  metadata: unknown | null;
  client: Queryable;
}): Promise<DocumentStatusSummary> {
  const { requirements } = await resolveRequirementsForApplication({
    lenderProductId: params.lenderProductId,
    productType: params.productType,
    requestedAmount: params.requestedAmount,
    country: resolveApplicationCountry(params.metadata),
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

  const requiredEntries = await listApplicationRequiredDocuments({
    applicationId: params.applicationId,
    client: params.client,
  });

  let allAccepted = true;
  let anyRejected = false;

  for (const key of requiredDocuments) {
    const entry = requiredEntries.find(
      (item) =>
        item.is_required &&
        normalizeRequiredDocumentKey(item.document_category) === key
    );
    if (!entry) {
      allAccepted = false;
      continue;
    }
    if (entry.status !== "accepted") {
      allAccepted = false;
    }
    if (entry.status === "rejected") {
      anyRejected = true;
    }
  }

  return { allAccepted, anyRejected };
}

function resolveNextStage(
  currentStage: ProcessingStage,
  data: ProcessingStageData
): ProcessingStage {
  const canEvaluateDocuments = data.ocrCompleted && data.bankingCompleted;
  const canStartCreditSummary =
    canEvaluateDocuments && data.allDocumentsAccepted;

  switch (currentStage) {
    case "pending":
      if (data.hasOcrJobsPending) {
        return "ocr_processing";
      }
      if (data.ocrCompleted) {
        return "ocr_complete";
      }
      return currentStage;
    case "ocr_processing":
      if (data.ocrCompleted) {
        return "ocr_complete";
      }
      return currentStage;
    case "ocr_complete":
      if (data.hasBankingJobsPending) {
        return "banking_processing";
      }
      if (data.bankingCompleted) {
        return "banking_complete";
      }
      return currentStage;
    case "banking_processing":
      if (data.bankingCompleted) {
        return "banking_complete";
      }
      return currentStage;
    case "banking_complete":
      if (canEvaluateDocuments && data.anyDocumentsRejected) {
        return "documents_incomplete";
      }
      if (canEvaluateDocuments && data.allDocumentsAccepted) {
        return "documents_complete";
      }
      return currentStage;
    case "documents_incomplete":
      if (canEvaluateDocuments && data.allDocumentsAccepted) {
        return "documents_complete";
      }
      return currentStage;
    case "documents_complete":
      if (canEvaluateDocuments && data.anyDocumentsRejected) {
        return "documents_incomplete";
      }
      if (canStartCreditSummary && data.creditSummaryCompleted) {
        return "credit_summary_complete";
      }
      if (canStartCreditSummary) {
        return "credit_summary_processing";
      }
      return currentStage;
    case "credit_summary_processing":
      if (canEvaluateDocuments && data.anyDocumentsRejected) {
        return "documents_incomplete";
      }
      if (data.creditSummaryCompleted) {
        return "credit_summary_complete";
      }
      return currentStage;
    case "credit_summary_complete":
      if (canEvaluateDocuments && data.anyDocumentsRejected) {
        return "documents_incomplete";
      }
      if (
        canStartCreditSummary &&
        data.creditSummaryCompleted &&
        data.allDocumentsAccepted
      ) {
        return "ready_for_lender";
      }
      return currentStage;
    case "ready_for_lender":
      if (canEvaluateDocuments && data.anyDocumentsRejected) {
        return "documents_incomplete";
      }
      return currentStage;
  }
}

async function advanceProcessingStageInternal(params: {
  applicationId: string;
  client: Queryable;
}): Promise<ProcessingStage> {
  const application = await params.client.runQuery<{
    id: string;
    processing_stage: string | null;
    ocr_completed_at: Date | null;
    banking_completed_at: Date | null;
    credit_summary_completed_at: Date | null;
    product_type: string;
    lender_product_id: string | null;
    requested_amount: number | null;
    metadata: unknown | null;
  }>(
    `select id, processing_stage, ocr_completed_at, banking_completed_at,
            credit_summary_completed_at, product_type, lender_product_id,
            requested_amount, metadata
     from applications
     where id = $1
     for update`,
    [params.applicationId]
  );

  const applicationRecord = application.rows[0];
  if (!applicationRecord) {
    throw new AppError("not_found", "Application not found.", 404);
  }

  if (
    applicationRecord.processing_stage &&
    !isProcessingStage(applicationRecord.processing_stage)
  ) {
    throw new AppError(
      "invalid_state",
      "Processing stage is invalid.",
      400
    );
  }

  const ocrJobs = await params.client.runQuery<{ count: number }>(
    `select count(*)::int as count
     from document_processing_jobs
     where application_id = $1
       and status = 'pending'`,
    [params.applicationId]
  );
  const bankingJobs = await params.client.runQuery<{ count: number }>(
    `select count(*)::int as count
     from banking_analysis_jobs
     where application_id = $1
       and status = 'pending'`,
    [params.applicationId]
  );

  const documentStatus = await fetchDocumentStatusSummary({
    applicationId: params.applicationId,
    productType: applicationRecord.product_type,
    lenderProductId: applicationRecord.lender_product_id,
    requestedAmount: applicationRecord.requested_amount,
    metadata: applicationRecord.metadata,
    client: params.client,
  });

  const stageData: ProcessingStageData = {
    ocrCompleted: Boolean(applicationRecord.ocr_completed_at),
    bankingCompleted: Boolean(applicationRecord.banking_completed_at),
    creditSummaryCompleted: Boolean(
      applicationRecord.credit_summary_completed_at
    ),
    hasOcrJobsPending: (ocrJobs.rows[0]?.count ?? 0) > 0,
    hasBankingJobsPending: (bankingJobs.rows[0]?.count ?? 0) > 0,
    allDocumentsAccepted: documentStatus.allAccepted,
    anyDocumentsRejected: documentStatus.anyRejected,
  };

  let currentStage = normalizeProcessingStage(
    applicationRecord.processing_stage
  );

  for (let i = 0; i < PROCESSING_STAGES.length; i += 1) {
    const nextStage = resolveNextStage(currentStage, stageData);
    if (nextStage === currentStage) {
      break;
    }
    currentStage = nextStage;
  }

  if (currentStage !== applicationRecord.processing_stage) {
    await params.client.runQuery(
      `update applications
       set processing_stage = $2,
           updated_at = now()
       where id = $1`,
      [params.applicationId, currentStage]
    );
  }

  if (currentStage === "credit_summary_processing") {
    await ensureCreditSummaryJob({ applicationId: params.applicationId, client: params.client });
  }

  return currentStage;
}

export async function advanceProcessingStage(params: {
  applicationId: string;
  client?: Queryable;
}): Promise<ProcessingStage> {
  if (params.client) {
    return advanceProcessingStageInternal({
      applicationId: params.applicationId,
      client: params.client,
    });
  }

  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const stage = await advanceProcessingStageInternal({
      applicationId: params.applicationId,
      client,
    });
    await client.runQuery("commit");
    return stage;
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}
