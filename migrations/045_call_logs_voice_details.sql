DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_status_enum') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'call_status_enum'::regtype
        AND enumlabel = 'in_progress'
    ) THEN
      ALTER TYPE call_status_enum ADD VALUE 'in_progress';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'call_status_enum'::regtype
        AND enumlabel = 'no_answer'
    ) THEN
      ALTER TYPE call_status_enum ADD VALUE 'no_answer';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'call_status_enum'::regtype
        AND enumlabel = 'busy'
    ) THEN
      ALTER TYPE call_status_enum ADD VALUE 'busy';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'call_status_enum'::regtype
        AND enumlabel = 'canceled'
    ) THEN
      ALTER TYPE call_status_enum ADD VALUE 'canceled';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'from_number'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN from_number text NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'to_number'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN to_number text NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'error_code'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN error_code text NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'error_message'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN error_message text NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'started_at'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
  END IF;
END $$;
