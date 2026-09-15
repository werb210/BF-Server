-- BF_SERVER_CALL_TASK_SUGGESTIONS_v253
-- Up to three AI-suggested follow-up tasks per call, drawn only from what was
-- said. Suggestions only: nothing is created until staff tap Add.
ALTER TABLE call_transcripts ADD COLUMN IF NOT EXISTS suggested_tasks jsonb;
