-- BF_SERVER_SEQ_TASK_STEP_v1 (Tasks Milestone 5) - sequence steps can create
-- tasks. No FK on task_queue_id: this file sorts before the tasks migration
-- on a fresh database, and the engine validates queue silo at run time.
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS task_type text;
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS task_priority text;
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS task_queue_id uuid;
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS task_pause boolean NOT NULL DEFAULT true;
