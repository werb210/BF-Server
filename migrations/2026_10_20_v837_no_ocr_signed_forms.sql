-- BF_SERVER_v837_NO_OCR_FOR_SIGNED_FORMS - Boreal's own signed SBA forms and signed applications are never OCR'd (there
-- is nothing to read from them). Some were left "OCR queued" (re-run OCR re-queued them); mark them as not needing OCR
-- and drop their waiting OCR jobs. Safe to run again.
UPDATE documents
   SET ocr_status = 'skipped', updated_at = now()
 WHERE lower(trim(coalesce(category, ''))) IN ('sba_forms', 'signed_application', 'signed application')
   AND coalesce(ocr_status, '') NOT IN ('skipped', 'completed');

DELETE FROM ocr_jobs
 WHERE status IN ('queued', 'failed')
   AND document_id::text IN (SELECT id::text FROM documents WHERE ocr_status = 'skipped');
