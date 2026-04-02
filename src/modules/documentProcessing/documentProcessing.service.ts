import { pool, runQuery } from "../../db";
import { AppError } from "../../middleware/errors";
import {
  fetchDocumentTypeAliases,
  normalizeRequiredDocumentKey,
} from "../../db/schema/requiredDocuments";
import type { PoolClient } from "pg";
import type {
  BankingAnalysisJobRecord,
  DocumentProcessingJobRecord,
} from "./documentProcessing.types";
import {
  createBankingAnalysisJob,
  createDocumentProcessingJob,
  listBankStatementDocuments,
  updateBankingAnalysisJob,
  updateDocumentProcessingJob,
} from "./documentProcessing.repo";
import { advanceProcessingStage } from "../applications/processingStage.service";
import { fetchCircuitBreaker } from "../../utils/circuitBreaker";

const BANK_STATEMENT_CATEGORY = "bank_statements_6_months";
const OCR_BREAKER = fetchCircuitBreaker("ocr_job_creation", {
  failureThreshold: 3,
  cooldownMs: 60_000,
});
const BANKING_BREAKER = fetchCircuitBreaker("banking_job_creation", {
  failureThreshold: 3,
  cooldownMs: 60_000,
});

type Queryable = Pick<PoolClient, "query" | "runQuery">;

function isBankStatementCategory(category: string): boolean {
  const normalized = normalizeRequiredDocumentKey(category) ?? category;
  return normalized === BANK_STATEMENT_CATEGORY;
}

export async function handleDocumentUploadProcessing(params: {
  applicationId: string;
  documentId: string;
  documentCategory: string;
  client?: Queryable;
}): Promise<{
  ocrJob: DocumentProcessingJobRecord | null;
  bankingJob: BankingAnalysisJobRecord | null;
}> {
  const normalizedCategory =
    normalizeRequiredDocumentKey(params.documentCategory) ?? params.documentCategory;
  if (!isBankStatementCategory(normalizedCategory)) {
    if (!OCR_BREAKER.canRequest()) {
      throw new AppError("circuit_open", "OCR circuit breaker is open.", 503);
    }
    try {
      const ocrJob = await createDocumentProcessingJob({
        documentId: params.documentId,
        jobType: "ocr",
        status: "pending",
        ...(params.client ? { client: params.client } : {}),
      });
      OCR_BREAKER.recordSuccess();
      return { ocrJob, bankingJob: null };
    } catch (err) {
      OCR_BREAKER.recordFailure();
      throw err;
    }
  }

  const aliases = fetchDocumentTypeAliases(BANK_STATEMENT_CATEGORY);
  const bankDocs = await listBankStatementDocuments({
    applicationId: params.applicationId,
    documentTypes: aliases,
    ...(params.client ? { client: params.client } : {}),
  });
  if (bankDocs.length < 6) {
    BANKING_BREAKER.recordSuccess();
    return { ocrJob: null, bankingJob: null };
  }
  const allUploaded = bankDocs.every((doc) => doc.status === "uploaded");
  if (!allUploaded) {
    BANKING_BREAKER.recordSuccess();
    return { ocrJob: null, bankingJob: null };
  }
  if (!BANKING_BREAKER.canRequest()) {
    throw new AppError("circuit_open", "Banking circuit breaker is open.", 503);
  }
  try {
    const bankingJob = await createBankingAnalysisJob({
      applicationId: params.applicationId,
      status: "pending",
      ...(params.client ? { client: params.client } : {}),
    });
    BANKING_BREAKER.recordSuccess();
    return { ocrJob: null, bankingJob };
  } catch (err) {
    BANKING_BREAKER.recordFailure();
    throw err;
  }
}

export async function markOcrCompleted(
  documentId: string
): Promise<DocumentProcessingJobRecord> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const job = await updateDocumentProcessingJob({
      documentId,
      jobType: "ocr",
      status: "completed",
      completedAt: new Date(),
      errorMessage: null,
      client,
    });
    if (!job) {
      throw new AppError("not_found", "OCR job not found.", 404);
    }
    const appRes = await client.runQuery(
      `update applications
       set ocr_completed_at = now(),
           updated_at = now()
       where id = (select application_id from documents where id = $1)
       returning id`,
      [documentId]
    );
    if (appRes.rows.length === 0) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    const applicationId = appRes.rows[0]?.id;
    if (!applicationId) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    await advanceProcessingStage({ applicationId, client });
    await client.runQuery("commit");
    return job;
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function markOcrFailed(params: {
  documentId: string;
  errorMessage: string;
}): Promise<DocumentProcessingJobRecord> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const job = await updateDocumentProcessingJob({
      documentId: params.documentId,
      jobType: "ocr",
      status: "failed",
      completedAt: new Date(),
      errorMessage: params.errorMessage,
      client,
    });
    if (!job) {
      throw new AppError("not_found", "OCR job not found.", 404);
    }
    await client.runQuery("commit");
    return job;
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function markBankingCompleted(params: {
  applicationId: string;
  monthsDetected: number;
}): Promise<BankingAnalysisJobRecord> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const job = await updateBankingAnalysisJob({
      applicationId: params.applicationId,
      status: "completed",
      monthsDetected: params.monthsDetected,
      completedAt: new Date(),
      errorMessage: null,
      client,
    });
    if (!job) {
      throw new AppError("not_found", "Banking analysis job not found.", 404);
    }
    await client.runQuery(
      `update applications
       set banking_completed_at = now(),
           updated_at = now()
       where id = $1`,
      [params.applicationId]
    );
    await advanceProcessingStage({ applicationId: params.applicationId, client });
    await client.runQuery("commit");
    return job;
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export async function markBankingFailed(params: {
  applicationId: string;
  errorMessage: string;
}): Promise<BankingAnalysisJobRecord> {
  const client = await pool.connect();
  try {
    await client.runQuery("begin");
    const job = await updateBankingAnalysisJob({
      applicationId: params.applicationId,
      status: "failed",
      monthsDetected: null,
      completedAt: new Date(),
      errorMessage: params.errorMessage,
      client,
    });
    if (!job) {
      throw new AppError("not_found", "Banking analysis job not found.", 404);
    }
    await client.runQuery("commit");
    return job;
  } catch (err) {
    await client.runQuery("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export function shouldEnqueueOcrForCategory(category: string): boolean {
  const normalized = normalizeRequiredDocumentKey(category) ?? category;
  return !isBankStatementCategory(normalized);
}
