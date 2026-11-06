-- BF_SERVER_v906_APPLICATION_FILE
-- 1) Credit Summary: what each button last did on a file (not run / running / done / failed), so the tab can show it.
CREATE TABLE IF NOT EXISTS credit_summary_steps (
  application_id text NOT NULL,
  step text NOT NULL,
  status text NOT NULL,
  message text,
  started_at timestamptz,
  finished_at timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (application_id, step)
);

-- 2) BF_SERVER_v906_OCR_MIME - document versions saved without a mimeType failed OCR with "missing_document_mime_type"
-- on every attempt. Fill the type in from the file name (only where it is missing), then re-queue the OCR jobs that
-- failed for that reason. Running this again changes nothing: the versions already have a type and the jobs are queued.
WITH v AS (
  SELECT dv.id,
         lower(substring(COALESCE(NULLIF(dv.metadata->>'fileName', ''), NULLIF(dv.metadata->>'originalName', ''), d.filename, d.title, '') from '\.([A-Za-z0-9]+)\s*$')) AS ext
    FROM document_versions dv
    LEFT JOIN documents d ON d.id = dv.document_id
   WHERE COALESCE(dv.metadata->>'mimeType', '') = ''
)
UPDATE document_versions dv
   SET metadata = COALESCE(dv.metadata, '{}'::jsonb) || jsonb_build_object('mimeType', CASE v.ext
         WHEN 'pdf' THEN 'application/pdf'
         WHEN 'png' THEN 'image/png'
         WHEN 'jpg' THEN 'image/jpeg'
         WHEN 'jpeg' THEN 'image/jpeg'
         WHEN 'gif' THEN 'image/gif'
         WHEN 'webp' THEN 'image/webp'
         WHEN 'heic' THEN 'image/heic'
         WHEN 'heif' THEN 'image/heif'
         WHEN 'tif' THEN 'image/tiff'
         WHEN 'tiff' THEN 'image/tiff'
         WHEN 'csv' THEN 'text/csv'
         WHEN 'txt' THEN 'text/plain'
         WHEN 'doc' THEN 'application/msword'
         WHEN 'docx' THEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
         WHEN 'xls' THEN 'application/vnd.ms-excel'
         WHEN 'xlsx' THEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
       END)
  FROM v
 WHERE v.id = dv.id
   AND v.ext IN ('pdf','png','jpg','jpeg','gif','webp','heic','heif','tif','tiff','csv','txt','doc','docx','xls','xlsx');

UPDATE documents d
   SET ocr_status = NULL, updated_at = now()
 WHERE COALESCE(d.ocr_status, '') = 'failed'
   AND EXISTS (SELECT 1 FROM ocr_jobs j WHERE j.document_id = d.id AND j.last_error = 'missing_document_mime_type' AND j.status IN ('failed', 'canceled'));

-- Re-queue every job that failed only for the missing type. A version whose type still could not be filled in from
-- its name is re-queued too: the OCR worker now works the type out from the file's first bytes.
UPDATE ocr_jobs
   SET status = 'queued', attempt_count = 0, next_attempt_at = now(), locked_at = NULL, locked_by = NULL,
       last_error = NULL, updated_at = now()
 WHERE last_error = 'missing_document_mime_type'
   AND status IN ('failed', 'canceled');
