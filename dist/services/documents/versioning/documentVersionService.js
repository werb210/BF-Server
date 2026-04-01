"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDocumentVersionRecord = createDocumentVersionRecord;
const crypto_1 = require("crypto");
const db_1 = require("../../../db");
async function createDocumentVersionRecord(params) {
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
    const result = await db_1.pool.runQuery(q, [(0, crypto_1.randomUUID)(), params.documentId, params.blobName, params.hash, params.metadata]);
    return result.rows[0];
}
