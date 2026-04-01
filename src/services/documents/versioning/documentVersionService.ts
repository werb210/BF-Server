import { randomUUID } from "crypto";
import { pool } from "../../../db";

export async function createDocumentVersionRecord(params: {
  documentId: string;
  blobName: string;
  hash: string;
  metadata: unknown;
}) {
  const q = `
    insert into document_versions
      (id, document_id, version, blob_name, hash, metadata, content, created_at)
    values
      (
        $1,
        $2,
        coalesce((select max(version) + 1 from document_versions where document_id = $2), 1),
        $3,
        $4,
        $5,
        '',
        now()
      )
    returning *
  `;

  const result = await pool.runQuery(q, [randomUUID(), params.documentId, params.blobName, params.hash, params.metadata]);
  return result.rows[0];
}
