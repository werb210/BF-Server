DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'submission_method_enum') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'submission_method_enum'
        AND pg_enum.enumlabel = 'GOOGLE_SHEETS'
    ) THEN
      ALTER TYPE submission_method_enum ADD VALUE 'GOOGLE_SHEETS';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'lender_submission_method') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_type.typname = 'lender_submission_method'
        AND pg_enum.enumlabel = 'GOOGLE_SHEETS'
    ) THEN
      ALTER TYPE lender_submission_method ADD VALUE 'GOOGLE_SHEETS';
    END IF;
  END IF;
END $$;
