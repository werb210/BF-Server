-- BF_SERVER_SEQ_STEP_ASSIGNEE_v1
-- A BF sequence task step had no assignee field: the task always went to the
-- contact's owner, falling back to the first active Admin. That is a sensible
-- default but it is not a choice, and there was no way to say "these follow-up
-- calls go to Caden". BI already carries an explicit assignee per step; this
-- brings BF to the same model.
--
-- Nullable on purpose: when it is null the existing contact-owner behaviour is
-- kept, so nothing created before this changes who it lands on.
ALTER TABLE marketing_sequence_steps ADD COLUMN IF NOT EXISTS assignee_user_id UUID;
