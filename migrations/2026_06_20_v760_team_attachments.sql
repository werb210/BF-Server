-- v760 — team chat message attachments (images/files as data URLs). Idempotent.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS attachments jsonb;
