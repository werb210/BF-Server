ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS previous_processing_stage TEXT;

CREATE TABLE IF NOT EXISTS application_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  reason TEXT,
  actor_user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS application_stage_history_app_idx
  ON application_stage_history(application_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_contact_id_fkey'
  ) THEN
    ALTER TABLE applications DROP CONSTRAINT applications_contact_id_fkey;
  END IF;
  ALTER TABLE applications
    ADD CONSTRAINT applications_contact_id_fkey
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_column THEN
  NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contacts_company_id_fkey'
  ) THEN
    ALTER TABLE contacts DROP CONSTRAINT contacts_company_id_fkey;
  END IF;
  ALTER TABLE contacts
    ADD CONSTRAINT contacts_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_column THEN
  NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'applications_company_id_fkey'
  ) THEN
    ALTER TABLE applications DROP CONSTRAINT applications_company_id_fkey;
  END IF;
  ALTER TABLE applications
    ADD CONSTRAINT applications_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_column THEN
  NULL;
END $$;
