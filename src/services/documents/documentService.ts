import { randomUUID } from "crypto";
import { pool } from "../../db";

type UploadInput = {
  applicationId: string;
  category: string;
  fileBuffer: Buffer;
  filename: string;
  size: number;
};

export async function uploadDocumentIdempotent(input: UploadInput) {
  const existing = await pool.query(
    `select id, application_id, document_type as category, filename, storage_key as "storageKey", 0::int as size
     from documents
     where application_id = $1
       and document_type = $2
       and filename = $3
     order by created_at desc
     limit 1`,
    [input.applicationId, input.category, input.filename]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const documentId = randomUUID();
  const storageKey = `documents/${documentId}/${input.filename}`;

  const created = await pool.query(
    `insert into documents (id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, created_at, updated_at)
     values ($1, $2, null, $3, $4, 'uploaded', $3, $5, 'client', now(), now())
     returning id, application_id, document_type as category, filename, storage_key as "storageKey", 0::int as size`,
    [documentId, input.applicationId, input.filename, input.category, storageKey]
  );

  return created.rows[0];
}
