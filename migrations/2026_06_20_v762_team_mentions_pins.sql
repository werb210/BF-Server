-- v762 — team chat @mentions + pinned messages. Idempotent.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS mentions  uuid[];
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
CREATE INDEX IF NOT EXISTS team_messages_pinned_idx ON team_messages (channel_id) WHERE pinned_at IS NOT NULL;
