-- BF_SERVER_DOCUMENT_CLASSIFIER_v196
ALTER TABLE documents ADD COLUMN IF NOT EXISTS detected_type TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS detected_confidence NUMERIC;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ;
-- The category the applicant chose, preserved before any retag. Without this a
-- wrong auto-retag is unrecoverable - we would have overwritten the only record
-- of what they actually said the file was.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS category_before_retag TEXT;

CREATE INDEX IF NOT EXISTS documents_detected_type_idx ON documents (detected_type);
