-- BF_SERVER_v70_BLOCK_1_1 — task checklist used by the submission chain to
-- determine "all action items complete" alongside "all required documents
-- accepted".

CREATE TABLE IF NOT EXISTS application_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  hashtag         TEXT,
  related_message_id UUID,
  completed_at    TIMESTAMPTZ,
  completed_by    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_tasks_app
  ON application_tasks(application_id);
CREATE INDEX IF NOT EXISTS idx_application_tasks_open
  ON application_tasks(application_id) WHERE status = 'open';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'application_tasks_status_check') THEN
    ALTER TABLE application_tasks
      ADD CONSTRAINT application_tasks_status_check
      CHECK (status IN ('open','completed','skipped'));
  END IF;
END $$;
