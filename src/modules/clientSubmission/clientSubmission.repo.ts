import { randomUUID } from "crypto";
import { pool, runQuery } from "../../db";
import { type PoolClient } from "pg";

type Queryable = Pick<PoolClient, "query" | "runQuery">;

export type ClientSubmissionRecord = {
  id: string;
  submission_key: string;
  application_id: string;
  payload: unknown;
  created_at: Date;
};

export async function findClientSubmissionByKey(
  submissionKey: string,
  client?: Queryable
): Promise<ClientSubmissionRecord | null> {
  const runner = client ?? pool;
  const res = await runner.query<ClientSubmissionRecord>(
    `select id, submission_key, application_id, payload, created_at
     from client_submissions
     where submission_key = $1
     limit 1`,
    [submissionKey]
  );
  return res.rows[0] ?? null;
}

export async function createClientSubmission(params: {
  submissionKey: string;
  applicationId: string;
  payload: unknown;
  client?: Queryable;
}): Promise<ClientSubmissionRecord> {
  const runner = params.client ?? pool;
  const res = await runner.query<ClientSubmissionRecord>(
    `insert into client_submissions
     (id, submission_key, application_id, payload, created_at)
     values ($1, $2, $3, $4, now())
     returning id, submission_key, application_id, payload, created_at`,
    [randomUUID(), params.submissionKey, params.applicationId, params.payload]
  );
  const record = res.rows[0];
  if (!record) {
    throw new Error("Failed to create client submission.");
  }
  return record;
}
