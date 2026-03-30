"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadDocumentIdempotent = uploadDocumentIdempotent;
const crypto_1 = require("crypto");
const db_1 = require("../../db");
async function uploadDocumentIdempotent(input) {
    const existing = await db_1.pool.query(`select id, application_id, document_type as category, filename, storage_key as "storageKey", 0::int as size
     from documents
     where application_id = $1
       and document_type = $2
       and filename = $3
     order by created_at desc
     limit 1`, [input.applicationId, input.category, input.filename]);
    if (existing.rows[0]) {
        return existing.rows[0];
    }
    const documentId = (0, crypto_1.randomUUID)();
    const storageKey = `documents/${documentId}/${input.filename}`;
    const created = await db_1.pool.query(`insert into documents (id, application_id, owner_user_id, title, document_type, status, filename, storage_key, uploaded_by, created_at, updated_at)
     values ($1, $2, null, $3, $4, 'uploaded', $3, $5, 'client', now(), now())
     returning id, application_id, document_type as category, filename, storage_key as "storageKey", 0::int as size`, [documentId, input.applicationId, input.filename, input.category, storageKey]);
    return created.rows[0];
}
