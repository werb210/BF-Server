-- BF_SERVER_v70_BLOCK_1_1 — documents table column backfill.
-- src/routes/documents.ts:37 expects: filename, hash, category, storage_path,
-- size_bytes, status, ocr_status, updated_at, rejection_reason. The original
-- 006 migration only created id, application_id, owner_user_id, title,
-- created_at. This brings the table in line with the code.
-- Idempotent (IF NOT EXISTS, guarded DROP NOT NULL).

ALTER TABLE documents ADD COLUMN IF NOT EXISTS filename         TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS hash             TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS category         TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_path     TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS size_bytes       BIGINT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status           TEXT NOT NULL DEFAULT 'uploaded';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ocr_status       TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE documents ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by      TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'owner_user_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE documents ALTER COLUMN owner_user_id DROP NOT NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'title' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE documents ALTER COLUMN title DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_application_id ON documents(application_id);
CREATE INDEX IF NOT EXISTS idx_documents_category       ON documents(application_id, category);
CREATE INDEX IF NOT EXISTS idx_documents_status         ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_ocr_status     ON documents(ocr_status);
