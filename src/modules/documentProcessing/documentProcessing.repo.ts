import { randomUUID } from "crypto";
import { pool, runQuery } from "../../db";
import type { PoolClient } from "pg";
import type {
  BankingAnalysisJobRecord,
  DocumentProcessingJobRecord,
  DocumentProcessingJobType,
  ProcessingJobStatus,
} from "./documentProcessing.types";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type BankStatementDocumentRow = {
  id: string;
  status: string;
};

export async function createDocumentProcessingJob(params: {
  documentId: string;
  jobType: DocumentProcessingJobType;
  status?: ProcessingJobStatus;
  client?: Queryable;
}): Promise<DocumentProcessingJobRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentProcessingJobRecord>(
    `insert into document_processing_jobs
     (id, application_id, document_id, job_type, status, created_at, updated_at)
     values ($1, (select application_id from documents where id = $2), $2, $3, $4, now(), now())
     on conflict (document_id, job_type)
     do update set updated_at = document_processing_jobs.updated_at
     returning id, document_id, job_type, status, started_at, completed_at, error_message,
               retry_count, last_retry_at, max_retries, created_at, updated_at`,
    [randomUUID(), params.documentId, params.jobType, params.status ?? "pending"]
  );
  const record = res.rows[0];
  if (!record) {
    throw new Error("Failed to create document processing job.");
  }
  return record;
}

export async function listBankStatementDocuments(params: {
  applicationId: string;
  documentTypes: string[];
  client?: Queryable;
}): Promise<BankStatementDocumentRow[]> {
  const runner = params.client ?? pool;
  const res = await runner.query<BankStatementDocumentRow>(
    `select id, status
     from documents
     where application_id = $1
       and document_type = any($2::text[])`,
    [params.applicationId, params.documentTypes]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

export async function createBankingAnalysisJob(params: {
  applicationId: string;
  status?: ProcessingJobStatus;
  client?: Queryable;
}): Promise<BankingAnalysisJobRecord> {
  const runner = params.client ?? pool;
  const existing = await runner.query<BankingAnalysisJobRecord>(
    `select id, application_id, status, statement_months_detected, started_at, completed_at,
            error_message, retry_count, last_retry_at, max_retries, created_at, updated_at
     from banking_analysis_jobs
     where application_id = $1
     limit 1`,
    [params.applicationId]
  );
  const existingRecord = existing.rows[0];
  if (existingRecord) {
    return existingRecord;
  }
  const res = await runner.query<BankingAnalysisJobRecord>(
    `insert into banking_analysis_jobs
     (id, application_id, status, created_at, updated_at)
     values ($1, $2, $3, now(), now())
     returning id, application_id, status, statement_months_detected, started_at, completed_at,
               error_message, retry_count, last_retry_at, max_retries, created_at, updated_at`,
    [randomUUID(), params.applicationId, params.status ?? "pending"]
  );
  const record = res.rows[0];
  if (!record) {
    throw new Error("Failed to create banking analysis job.");
  }
  return record;
}

export async function updateDocumentProcessingJob(params: {
  documentId: string;
  jobType: DocumentProcessingJobType;
  status: ProcessingJobStatus;
  completedAt?: Date | null;
  errorMessage?: string | null;
  client?: Queryable;
}): Promise<DocumentProcessingJobRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<DocumentProcessingJobRecord>(
    `update document_processing_jobs
     set status = $3,
         completed_at = $4,
         error_message = $5,
         updated_at = now()
     where document_id = $1 and job_type = $2
     returning id, document_id, job_type, status, started_at, completed_at, error_message,
               retry_count, last_retry_at, max_retries, created_at, updated_at`,
    [
      params.documentId,
      params.jobType,
      params.status,
      params.completedAt ?? null,
      params.errorMessage ?? null,
    ]
  );
  return res.rows[0] ?? null;
}

export async function updateBankingAnalysisJob(params: {
  applicationId: string;
  status: ProcessingJobStatus;
  monthsDetected?: number | null;
  completedAt?: Date | null;
  errorMessage?: string | null;
  client?: Queryable;
}): Promise<BankingAnalysisJobRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<BankingAnalysisJobRecord>(
    `update banking_analysis_jobs
     set status = $2,
         statement_months_detected = $3,
         completed_at = $4,
         error_message = $5,
         updated_at = now()
     where application_id = $1
     returning id, application_id, status, statement_months_detected, started_at, completed_at,
               error_message, retry_count, last_retry_at, max_retries, created_at, updated_at`,
    [
      params.applicationId,
      params.status,
      params.monthsDetected ?? null,
      params.completedAt ?? null,
      params.errorMessage ?? null,
    ]
  );
  return res.rows[0] ?? null;
}
