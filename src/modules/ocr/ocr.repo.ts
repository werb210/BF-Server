import { randomUUID } from "crypto";
import { pool } from "../../db";
import { type PoolClient } from "pg";
import { runtimeEnv } from "src/server/config/config";
import {
  type OcrDocumentResultRecord,
  type OcrJobRecord,
  type OcrJobStatus,
  type OcrResultRecord,
} from "./ocr.types";

export type Queryable = Pick<PoolClient, "query">;

export async function createOcrJob(params: {
  documentId: string;
  applicationId: string;
  maxAttempts: number;
  client?: Queryable;
}): Promise<OcrJobRecord> {
  const runner = params.client ?? pool;
  if (process.env.NODE_ENV === "test") {
    const existing = await runner.query<OcrJobRecord>(
      `select id, document_id, application_id, status, attempt_count, max_attempts,
              next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at
       from ocr_jobs
       where document_id = $1
       limit 1`,
      [params.documentId]
    );
    const existingRecord = existing.rows[0];
    if (existingRecord) {
      return existingRecord;
    }
    const inserted = await runner.query<OcrJobRecord>(
      `insert into ocr_jobs
       (id, document_id, application_id, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
       values ($1, $2, $3, 'queued', 0, $4, now(), now(), now())
       returning id, document_id, application_id, status, attempt_count, max_attempts,
                 next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`,
      [randomUUID(), params.documentId, params.applicationId, params.maxAttempts]
    );
    const insertedRecord = inserted.rows[0];
    if (!insertedRecord) {
      throw new Error("Failed to create OCR job.");
    }
    return insertedRecord;
  }
  const res = await runner.query<OcrJobRecord>(
    `insert into ocr_jobs
     (id, document_id, application_id, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
     values ($1, $2, $3, 'queued', 0, $4, now(), now(), now())
     on conflict (document_id)
     do update set updated_at = ocr_jobs.updated_at
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`,
    [randomUUID(), params.documentId, params.applicationId, params.maxAttempts]
  );
  const record = res.rows[0];
  if (!record) {
    throw new Error("Failed to create OCR job.");
  }
  return record;
}

export async function lockOcrJobs(params: {
  limit: number;
  lockedBy: string;
  client?: Queryable;
}): Promise<OcrJobRecord[]> {
  const runner = params.client ?? pool;
  const lockTimeoutMinutes = runtimeEnv.ocrLockTimeoutMinutes;
  const res = await runner.query<OcrJobRecord>(
    `with candidates as (
       select id
       from ocr_jobs
       where (
         (status in ('queued', 'failed') and (next_attempt_at is null or next_attempt_at <= now()::timestamp))
         or status = 'processing'
       )
         and (locked_at is null or locked_at <= now() - ($3 * interval '1 minute'))
       order by created_at asc
       limit $1
       for update skip locked
     )
     update ocr_jobs
     set status = 'processing',
         locked_at = now()::timestamp,
         locked_by = $2,
         updated_at = now()::timestamp
     where id in (select id from candidates)
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`,
    [params.limit, params.lockedBy, lockTimeoutMinutes]
  );
  return res.rows;
}

export async function clearExpiredOcrLocks(params?: { client?: Queryable }): Promise<number> {
  const runner = params?.client ?? pool;
  const lockTimeoutMinutes = runtimeEnv.ocrLockTimeoutMinutes;
  const res = await runner.query<{ count: string }>(
    `update ocr_jobs
     set locked_at = null,
         locked_by = null,
         updated_at = now()
     where locked_at is not null
       and locked_at <= now() - ($1 * interval '1 minute')
     returning id`,
    [lockTimeoutMinutes]
  );
  return res.rows.length;
}

export async function markOcrJobSuccess(params: {
  jobId: string;
  documentId: string;
  provider: string;
  model: string;
  extractedText: string;
  extractedJson: unknown | null;
  meta: unknown | null;
  client?: PoolClient;
}): Promise<void> {
  const runner = params.client ?? (await pool.connect());
  const release = params.client ? null : () => (runner as PoolClient).release();
  await runner.query("begin");
  try {
    await runner.query(
      `insert into ocr_document_results
       (id, document_id, provider, model, extracted_text, extracted_json, meta, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now(), now())
       on conflict (document_id) do nothing`,
      [
        randomUUID(),
        params.documentId,
        params.provider,
        params.model,
        params.extractedText,
        params.extractedJson,
        params.meta,
      ]
    );
    await runner.query(
      `update ocr_jobs
       set status = 'succeeded',
           next_attempt_at = null,
           locked_at = null,
           locked_by = null,
           last_error = null,
           updated_at = now()
       where id = $1`,
      [params.jobId]
    );
    await runner.query("commit");
  } catch (error) {
    await runner.query("rollback");
    throw error;
  } finally {
    release?.();
  }
}

export async function markOcrJobFailure(params: {
  jobId: string;
  attemptCount: number;
  status: OcrJobStatus;
  lastError: string;
  nextAttemptAt: Date | null;
  maxAttempts: number;
  client?: Queryable;
}): Promise<OcrJobRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<OcrJobRecord>(
    `update ocr_jobs
     set attempt_count = $2,
         status = $3,
         next_attempt_at = $4,
         max_attempts = $5::int,
         locked_at = null,
         locked_by = null,
         last_error = $6,
         updated_at = now()
     where id = $1
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`,
    [
      params.jobId,
      params.attemptCount,
      params.status,
      params.nextAttemptAt,
      params.maxAttempts,
      params.lastError,
    ]
  );
  return res.rows[0] ?? null;
}

export async function resetOcrJob(params: {
  jobId: string;
  client?: Queryable;
}): Promise<OcrJobRecord | null> {
  const runner = params.client ?? pool;
  const res = await runner.query<OcrJobRecord>(
    `update ocr_jobs
     set status = 'queued',
         attempt_count = 0,
         next_attempt_at = now(),
         locked_at = null,
         locked_by = null,
         last_error = null,
         updated_at = now()
     where id = $1
     returning id, document_id, application_id, status, attempt_count, max_attempts,
               next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at`,
    [params.jobId]
  );
  return res.rows[0] ?? null;
}

export async function findOcrJobByDocumentId(
  documentId: string,
  client?: Queryable
): Promise<OcrJobRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<OcrJobRecord>(
    `select id, document_id, application_id, status, attempt_count, max_attempts,
            next_attempt_at, locked_at, locked_by, last_error, created_at, updated_at
     from ocr_jobs
     where document_id = $1
     limit 1`,
    [documentId]
  );
  return res.rows[0] ?? null;
}

export async function findOcrResultByDocumentId(
  documentId: string,
  client?: Queryable
): Promise<OcrDocumentResultRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<OcrDocumentResultRecord>(
    `select id, document_id, provider, model, extracted_text, extracted_json, meta, created_at, updated_at
     from ocr_document_results
     where document_id = $1
     order by created_at desc
     limit 1`,
    [documentId]
  );
  return res.rows[0] ?? null;
}

export async function insertDocumentOcrFields(params: {
  documentId: string;
  applicationId: string;
  documentType: string | null;
  fields: Array<{
    fieldKey: string;
    value: string;
    confidence: number;
  }>;
  client?: Queryable;
}): Promise<OcrResultRecord[]> {
  const runner = params.client ?? pool;
  if (params.fields.length === 0) {
    return [];
  }
  const values: Array<string | number | null> = [];
  const placeholders: string[] = [];
  params.fields.forEach((field, index) => {
    const base = index * 7;
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, now())`
    );
    values.push(
      randomUUID(),
      params.applicationId,
      params.documentId,
      field.fieldKey,
      field.value,
      field.confidence,
      params.documentType
    );
  });
  const result = await runner.query<OcrResultRecord>(
    `insert into ocr_results
     (id, application_id, document_id, field_key, value, confidence, source_document_type, created_at)
     values ${placeholders.join(", ")}
     returning id, application_id, document_id, field_key, value, confidence, source_document_type, created_at`,
    values
  );
  return result.rows;
}

export type OcrApplicationResultRow = {
  document_id: string;
  document_type: string;
  extracted_json: unknown | null;
};

export async function listOcrResultsForApplication(
  applicationId: string,
  client?: Queryable
): Promise<OcrApplicationResultRow[]> {
  const runner = client ?? pool;
  const res = await runner.query<OcrApplicationResultRow>(
    `select d.id as document_id,
            d.document_type,
            r.extracted_json
     from documents d
     left join ocr_document_results r on r.document_id = d.id
     where d.application_id = $1
     order by d.created_at asc`,
    [applicationId]
  );
  return res.rows ?? [];
}

export type OcrFieldApplicationRow = {
  document_id: string;
  application_id: string;
  field_key: string;
  value: string;
  confidence: number;
  source_document_type: string | null;
  created_at: Date;
};

export async function listOcrFieldsForApplication(
  applicationId: string,
  client?: Queryable
): Promise<OcrFieldApplicationRow[]> {
  const runner = client ?? pool;
  const res = await runner.query<OcrFieldApplicationRow>(
    `select document_id,
            application_id,
            field_key,
            value,
            confidence,
            source_document_type,
            created_at
     from ocr_results
     where application_id = $1
     order by created_at asc`,
    [applicationId]
  );
  return res.rows ?? [];
}
