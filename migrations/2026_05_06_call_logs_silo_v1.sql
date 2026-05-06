ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF';

UPDATE call_logs
SET silo = 'BF'
WHERE silo IS NULL;

CREATE INDEX IF NOT EXISTS call_logs_silo_idx ON call_logs(silo);
