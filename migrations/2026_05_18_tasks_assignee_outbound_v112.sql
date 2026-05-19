-- Block 112 (revived for live migration dir)
DO $$
BEGIN
  IF to_regclass('public.calendar_tasks') IS NOT NULL THEN
    ALTER TABLE calendar_tasks ADD COLUMN IF NOT EXISTS assignee_user_id UUID;
    CREATE INDEX IF NOT EXISTS idx_calendar_tasks_assignee ON calendar_tasks(assignee_user_id);
  END IF;

  IF to_regclass('public.tasks') IS NOT NULL THEN
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee_user_id UUID;
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_user_id);
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS outbound_caller_id TEXT;
