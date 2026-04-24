ALTER TABLE lenders
  ADD COLUMN IF NOT EXISTS email TEXT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lenders'
      AND column_name = 'status'
  ) THEN
    UPDATE lenders
    SET status = CASE
      WHEN status IS NULL THEN 'ACTIVE'
      WHEN LOWER(status::text) = 'inactive' THEN 'INACTIVE'
      ELSE 'ACTIVE'
    END;
  END IF;
END $$;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname
    INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'lenders'
    AND n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE lenders DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'lenders'
      AND column_name = 'status'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'lenders'
        AND n.nspname = 'public'
        AND c.conname = 'lenders_status_check'
    ) THEN
      ALTER TABLE lenders
        ADD CONSTRAINT lenders_status_check
        CHECK (status::text IN ('ACTIVE', 'INACTIVE'));
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'pipeline_state'
  ) THEN
    UPDATE applications
    SET pipeline_state = CASE
      WHEN pipeline_state IS NULL THEN 'RECEIVED'
      WHEN UPPER(pipeline_state) = 'NEW' THEN 'RECEIVED'
      WHEN UPPER(pipeline_state) = 'REQUIRES_DOCS' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(pipeline_state) = 'UNDER_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(pipeline_state) = 'LENDER_SUBMITTED' THEN 'OFF_TO_LENDER'
      WHEN UPPER(pipeline_state) = 'APPROVED' THEN 'ACCEPTED'
      WHEN UPPER(pipeline_state) = 'FUNDED' THEN 'ACCEPTED'
      WHEN UPPER(pipeline_state) = 'DECLINED' THEN 'DECLINED'
      WHEN UPPER(pipeline_state) = 'DOCUMENTS_REQUIRED' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(pipeline_state) = 'IN_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(pipeline_state) IN ('START_UP', 'STARTUP') THEN 'STARTUP'
      WHEN UPPER(pipeline_state) = 'OFF_TO_LENDER' THEN 'OFF_TO_LENDER'
      WHEN UPPER(pipeline_state) = 'ACCEPTED' THEN 'ACCEPTED'
      ELSE 'RECEIVED'
    END;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'status'
  ) THEN
    UPDATE applications
    SET status = CASE
      WHEN status IS NULL THEN pipeline_state
      WHEN UPPER(status) = 'NEW' THEN 'RECEIVED'
      WHEN UPPER(status) = 'REQUIRES_DOCS' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(status) = 'UNDER_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(status) = 'LENDER_SUBMITTED' THEN 'OFF_TO_LENDER'
      WHEN UPPER(status) = 'APPROVED' THEN 'ACCEPTED'
      WHEN UPPER(status) = 'FUNDED' THEN 'ACCEPTED'
      WHEN UPPER(status) = 'DECLINED' THEN 'DECLINED'
      WHEN UPPER(status) = 'DOCUMENTS_REQUIRED' THEN 'DOCUMENTS_REQUIRED'
      WHEN UPPER(status) = 'IN_REVIEW' THEN 'IN_REVIEW'
      WHEN UPPER(status) IN ('START_UP', 'STARTUP') THEN 'STARTUP'
      WHEN UPPER(status) = 'OFF_TO_LENDER' THEN 'OFF_TO_LENDER'
      WHEN UPPER(status) = 'ACCEPTED' THEN 'ACCEPTED'
      ELSE pipeline_state
    END;
  END IF;
END $$;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname
    INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'applications'
    AND n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%pipeline_state%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE applications DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'pipeline_state'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'applications'
        AND n.nspname = 'public'
        AND c.conname = 'applications_pipeline_state_check'
    ) THEN
      ALTER TABLE applications
        ADD CONSTRAINT applications_pipeline_state_check
        CHECK (pipeline_state IN (
          'RECEIVED',
          'DOCUMENTS_REQUIRED',
          'IN_REVIEW',
          'STARTUP',
          'OFF_TO_LENDER',
          'ACCEPTED',
          'DECLINED'
        ));
    END IF;
  END IF;
END $$;

DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname
    INTO constraint_name
  FROM pg_constraint c
  JOIN pg_class t ON c.conrelid = t.oid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE t.relname = 'applications'
    AND n.nspname = 'public'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE applications DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'applications'
      AND column_name = 'status'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'applications'
        AND n.nspname = 'public'
        AND c.conname = 'applications_status_check'
    ) THEN
      ALTER TABLE applications
        ADD CONSTRAINT applications_status_check
        CHECK (status IS NULL OR status IN (
          'RECEIVED',
          'DOCUMENTS_REQUIRED',
          'IN_REVIEW',
          'STARTUP',
          'OFF_TO_LENDER',
          'ACCEPTED',
          'DECLINED'
        ));
    END IF;
  END IF;
END $$;
