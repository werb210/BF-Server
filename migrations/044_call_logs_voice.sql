DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'twilio_call_sid'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN twilio_call_sid text NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'call_status_enum') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'call_status_enum'::regtype
        AND enumlabel = 'completed'
    ) THEN
      ALTER TYPE call_status_enum ADD VALUE 'completed';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_enum
      WHERE enumtypid = 'call_status_enum'::regtype
        AND enumlabel = 'cancelled'
    ) THEN
      ALTER TYPE call_status_enum ADD VALUE 'cancelled';
    END IF;
  END IF;
END $$;
