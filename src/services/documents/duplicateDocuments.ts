// BF_SERVER_DOCUMENT_DUPLICATE_GUARD_v256
// One file, one copy, per application. Every upload path for application
// documents (applicant wizard, portal staff, accountant) goes through
// persistAndEnqueue, which now refuses a file whose SHA-256 fingerprint already
// exists on the same application - in any category and any status. Delete is a
// hard delete, so removing a copy frees the file to be uploaded again.
//
// Linked legs (closing-cost companions) keep receiving shared copies: that
// mirror writes to a different application and already skips same-hash files.
import { pool } from "../../db.js";
import { hashBuffer } from "./hashService.js";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
const defaultQuery: Query = (sql, params) => pool.query(sql, params as any[]);

export type ExistingDocument = { id: string; category: string | null; filename: string | null; status: string | null };

export class DuplicateDocumentError extends Error {
  readonly existing: ExistingDocument;
  constructor(existing: ExistingDocument) {
    super(`This file is already uploaded on this application${existing.category ? ` under ${existing.category}` : ""}.`);
    this.name = "DuplicateDocumentError";
    this.existing = existing;
  }
}

export function fingerprint(buffer: Buffer): string {
  return hashBuffer(buffer);
}

export async function findDuplicateOnApplication(
  applicationId: string,
  hash: string,
  query: Query = defaultQuery,
): Promise<ExistingDocument | null> {
  const { rows } = await query(
    `SELECT id::text AS id, category, filename, status
       FROM documents
      WHERE application_id::text = ($1)::text AND hash = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [applicationId, hash],
  );
  return rows[0] ?? null;
}

/** Throws DuplicateDocumentError when the application already holds this exact file. */
export async function assertNotDuplicate(applicationId: string, buffer: Buffer, query: Query = defaultQuery): Promise<string> {
  const hash = fingerprint(buffer);
  const existing = await findDuplicateOnApplication(applicationId, hash, query);
  if (existing) throw new DuplicateDocumentError(existing);
  return hash;
}

export function duplicateResponseBody(err: DuplicateDocumentError) {
  return { ok: false, error: "DUPLICATE_DOCUMENT", message: err.message, existing: err.existing };
}

export type DuplicateGroup = { hash: string; original: ExistingDocument & { created_at: string }; copies: Array<ExistingDocument & { created_at: string }> };

/** Existing duplicates on an application, oldest copy treated as the original. */
export async function duplicateGroupsForApplication(applicationId: string, query: Query = defaultQuery): Promise<DuplicateGroup[]> {
  const { rows } = await query(
    `SELECT hash,
            json_agg(json_build_object(
              'id', id::text, 'category', category, 'filename', filename,
              'status', status, 'created_at', created_at
            ) ORDER BY created_at ASC) AS docs
       FROM documents
      WHERE application_id::text = ($1)::text
        AND hash IS NOT NULL AND hash <> '' AND hash <> 'mock-hash'
      GROUP BY hash
     HAVING COUNT(*) > 1`,
    [applicationId],
  );
  return rows
    .map((r) => {
      const docs = Array.isArray(r.docs) ? r.docs : [];
      return { hash: String(r.hash), original: docs[0], copies: docs.slice(1) };
    })
    .filter((g) => g.original && g.copies.length > 0);
}
