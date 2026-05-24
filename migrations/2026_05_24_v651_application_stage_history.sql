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
  -- v651 hotfix: nullify any orphan applications.contact_id references
  -- so the SET NULL FK can be added cleanly. Orphans exist from earlier
  -- contact merges where the FK was RESTRICT/CASCADE and bypass paths
  -- left dangling refs. Nulling them is consistent with the new ON
  -- DELETE SET NULL semantics this migration is establishing anyway.
  UPDATE applications
     SET contact_id = NULL
   WHERE contact_id IS NOT NULL
     AND contact_id NOT IN (SELECT id FROM contacts);

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
  -- v651 hotfix: nullify orphan contacts.company_id references before
  -- re-adding the SET NULL FK constraint.
  UPDATE contacts
     SET company_id = NULL
   WHERE company_id IS NOT NULL
     AND company_id NOT IN (SELECT id FROM companies);

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
  -- v651 hotfix: nullify orphan applications.company_id references before
  -- re-adding the SET NULL FK constraint.
  UPDATE applications
     SET company_id = NULL
   WHERE company_id IS NOT NULL
     AND company_id NOT IN (SELECT id FROM companies);

  ALTER TABLE applications
    ADD CONSTRAINT applications_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE SET NULL;
EXCEPTION WHEN undefined_column THEN
  NULL;
END $$;
