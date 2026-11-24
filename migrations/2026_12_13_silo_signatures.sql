-- BF_SERVER_SILO_SIGNATURES_v1 - one personal email signature per business (Keystone, BI, SLF); the Boreal Financial
-- signature stays in email_signature_html. Idempotent.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_signatures_by_silo jsonb NOT NULL DEFAULT '{}'::jsonb;
