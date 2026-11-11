-- BF_SERVER_v939_SHARED_DOC_VERSIONS - documents shared from a client's earlier application were copied without a
-- document_versions row, so OCR failed with document_version_missing. Give each such copy its source's latest version.
INSERT INTO document_versions (id, document_id, version, blob_name, hash, metadata, content, created_at)
SELECT gen_random_uuid()::text, s.target_document_id, 1, v.blob_name, v.hash, v.metadata, v.content, now()
  FROM document_shares s
  JOIN LATERAL (SELECT * FROM document_versions dv WHERE dv.document_id = s.source_document_id ORDER BY dv.version DESC LIMIT 1) v ON true
 WHERE NOT EXISTS (SELECT 1 FROM document_versions x WHERE x.document_id = s.target_document_id);
-- Let OCR try those copies again.
UPDATE ocr_jobs j SET status = 'queued', attempt_count = 0, last_error = NULL, next_attempt_at = now(), updated_at = now()
  FROM document_shares s
 WHERE j.document_id = s.target_document_id AND j.status = 'failed' AND j.last_error = 'document_version_missing';
