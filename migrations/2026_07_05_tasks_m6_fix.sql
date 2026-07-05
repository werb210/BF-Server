-- BF_SERVER_TASKS_M6_FIX_v1 - the M6 migration created task_digest_log.user_id
-- as text, but notifications.user_id and tasks.assignee_user_id are uuid, so
-- the worker's inserts failed with "column user_id is of type uuid but
-- expression is of type text". Align task_digest_log.user_id to uuid. Guarded
-- so it only runs when the column is still text (idempotent on re-run).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'task_digest_log' AND column_name = 'user_id' AND data_type <> 'uuid'
  ) THEN
    -- table is small/ephemeral (one row per user per day); safe to clear any
    -- text rows that cannot cast rather than risk a bad cast.
    DELETE FROM task_digest_log WHERE user_id !~ '^[0-9a-fA-F-]{36}$';
    ALTER TABLE task_digest_log ALTER COLUMN user_id TYPE uuid USING user_id::uuid;
  END IF;
END $$;
