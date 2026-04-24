DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'recording_sid'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN recording_sid text NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'recording_duration_seconds'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN recording_duration_seconds integer NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'call_logs'
      AND constraint_name = 'call_logs_recording_duration_check'
  ) THEN
    ALTER TABLE call_logs
      ADD CONSTRAINT call_logs_recording_duration_check
      CHECK (recording_duration_seconds IS NULL OR recording_duration_seconds >= 0);
  END IF;
END $$;
