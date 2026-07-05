-- BF_SERVER_TASKS_M6_v1 (Tasks Milestone 6) - reminder dedupe stamp + the
-- daily-digest dedupe log. Idempotent; the tasks recurrence columns already
-- exist from the M1 migration.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS task_digest_log (
  user_id text NOT NULL,
  digest_date date NOT NULL,
  notified_at timestamptz,
  PRIMARY KEY (user_id, digest_date)
);
