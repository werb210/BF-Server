-- BF_SERVER_ABANDONED_NUDGE_v61
-- Stamps on the application so each nudge fires at most once, and so a re-run
-- after a restart cannot re-text somebody. Idempotent per the repo convention.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS abandon_sms_sent_at   timestamptz,
  ADD COLUMN IF NOT EXISTS abandon_task_created_at timestamptz;

-- The worker scans for unsubmitted applications on every tick; without this it
-- is a sequential scan of the whole table every 15 minutes.
CREATE INDEX IF NOT EXISTS idx_applications_abandon_nudge
  ON applications (updated_at)
  WHERE submitted_at IS NULL;
