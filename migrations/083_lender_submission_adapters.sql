alter table if exists lenders
  add column if not exists submission_config jsonb null;

alter table if exists lender_submissions
  add column if not exists submission_method text null,
  add column if not exists external_reference text null;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'status'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'applications'
        AND n.nspname = 'public'
        AND c.conname = 'applications_status_check'
    ) THEN
      ALTER TABLE applications
        DROP CONSTRAINT applications_status_check;
    END IF;

    ALTER TABLE applications
      ADD CONSTRAINT applications_status_check
      CHECK (status IS NULL OR status IN (
        'RECEIVED',
        'DOCUMENTS_REQUIRED',
        'IN_REVIEW',
        'STARTUP',
        'OFF_TO_LENDER',
        'SUBMITTED_TO_LENDER',
        'ACCEPTED',
        'DECLINED'
      ));
  END IF;
END $$;
