DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'answered'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN answered boolean NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'ended_reason'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN ended_reason varchar(64) NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'call_logs' AND column_name = 'price_estimate_cents'
  ) THEN
    ALTER TABLE call_logs
      ADD COLUMN price_estimate_cents integer NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS crm_task (
  id uuid PRIMARY KEY,
  type varchar(64) NOT NULL,
  staff_id uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  phone_number text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_task_staff_created_idx ON crm_task (staff_id, created_at DESC);
