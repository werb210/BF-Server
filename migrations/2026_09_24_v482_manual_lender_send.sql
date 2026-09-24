-- BF_SERVER_BLOCK_v482_MARK_SENT_TO_LENDER
-- A package row can now record a send that happened outside the portal
-- (emailed by hand, lender portal upload). Idempotent.
ALTER TABLE application_packages ADD COLUMN IF NOT EXISTS sent_manually BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE application_packages ADD COLUMN IF NOT EXISTS sent_by_user_id TEXT;
ALTER TABLE application_packages ADD COLUMN IF NOT EXISTS sent_note TEXT;
