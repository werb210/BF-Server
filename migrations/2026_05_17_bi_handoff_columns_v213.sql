-- BF_SERVER_BLOCK_v213_BF_TO_BI_HANDOFF_v1
-- Reverse-link from a BF application to the BI row created during
-- the PGI handoff. All columns nullable + idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bi_application_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bi_public_id TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS bi_completion_url TEXT;
CREATE INDEX IF NOT EXISTS idx_applications_bi_application_id
  ON applications(bi_application_id)
  WHERE bi_application_id IS NOT NULL;
