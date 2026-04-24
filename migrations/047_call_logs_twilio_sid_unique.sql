DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE tablename = 'call_logs'
      AND indexname = 'call_logs_twilio_call_sid_unique'
  ) THEN
    CREATE UNIQUE INDEX call_logs_twilio_call_sid_unique
      ON call_logs (twilio_call_sid)
      WHERE twilio_call_sid IS NOT NULL;
  END IF;
END $$;
