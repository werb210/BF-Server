-- BF_SERVER_SBA_ATTACH_LOCK_v796
-- Concurrent SignNow webhooks filed each signed SBA form several times. Keep the most recently written copy of
-- each (application, file name) and remove the extras (their versions and OCR rows cascade), then make a second
-- copy impossible.
DELETE FROM documents d
 USING (
   SELECT id, ROW_NUMBER() OVER (PARTITION BY application_id, filename ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id) AS rn
     FROM documents
    WHERE uploaded_by = 'system' AND document_type = 'sba_forms'
 ) dup
 WHERE d.id = dup.id AND dup.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS documents_sba_forms_one_per_file
  ON documents (application_id, filename)
  WHERE uploaded_by = 'system' AND document_type = 'sba_forms';
