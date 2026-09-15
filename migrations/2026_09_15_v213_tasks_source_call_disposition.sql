-- BF_SERVER_TASKS_TABLE_FIX_v213
-- The disposition follow-up (BF_SERVER_DISPOSITION_TASK_v1) inserts
-- source = 'CALL_DISPOSITION', but tasks.source carries a CHECK constraint
-- allowing only MANUAL|SEQUENCE|WORKFLOW|IMPORT|API. Every insert therefore
-- raised 23514 and no follow-up task has ever been created - the automatic
-- follow-up is silently dead, not merely unused.
--
-- Widen the constraint rather than changing the value: 'CALL_DISPOSITION' is
-- what the dedupe predicate already matches on, and rewriting it would orphan
-- any row that did land.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_check
  CHECK (source IN ('MANUAL','SEQUENCE','WORKFLOW','IMPORT','API','CALL_DISPOSITION'));

CREATE INDEX IF NOT EXISTS tasks_assignee_due_open_idx
  ON tasks (assignee_user_id, due_at)
  WHERE status <> 'COMPLETED';
