-- BF_MINI_PORTAL_NOTES_v47 — idempotent.
ALTER TABLE crm_notes ADD COLUMN IF NOT EXISTS application_id text;
ALTER TABLE crm_notes ADD COLUMN IF NOT EXISTS mentions      text[] NOT NULL DEFAULT '{}';
ALTER TABLE crm_notes ADD COLUMN IF NOT EXISTS is_deleted    boolean NOT NULL DEFAULT false;
ALTER TABLE crm_notes ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS idx_crm_notes_application_id ON crm_notes(application_id) WHERE application_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_notes_mentions       ON crm_notes USING gin (mentions);
