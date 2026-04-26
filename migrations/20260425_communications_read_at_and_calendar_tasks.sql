-- Add read_at to communications_messages so /sms/thread can mark messages read.
ALTER TABLE IF EXISTS communications_messages
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_communications_messages_read_at
  ON communications_messages (read_at);

-- Calendar tasks (separate from o365_tasks; staff portal tasks live here when O365 is not connected,
-- and are mirrored TO O365 when O365 is connected — handled in route handler).
CREATE TABLE IF NOT EXISTS calendar_tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL,
  silo          TEXT NOT NULL DEFAULT 'BF',
  title         TEXT NOT NULL,
  notes         TEXT NULL,
  due_at        TIMESTAMPTZ NULL,
  priority      TEXT NOT NULL DEFAULT 'normal',
  status        TEXT NOT NULL DEFAULT 'open',
  o365_task_id  TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_tasks_user_silo ON calendar_tasks (user_id, silo);
CREATE INDEX IF NOT EXISTS idx_calendar_tasks_due_at ON calendar_tasks (due_at);
CREATE INDEX IF NOT EXISTS idx_calendar_tasks_status ON calendar_tasks (status);
