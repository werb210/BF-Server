-- BF_SERVER_TEAM_PHASE_B_v658 - Team chat Phase B: named channels with a topic, private or
-- public, archive; threads (replies grouped under a root message).
ALTER TABLE team_channels ADD COLUMN IF NOT EXISTS topic text;
ALTER TABLE team_channels ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false;
ALTER TABLE team_channels ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS thread_root_id uuid;
CREATE INDEX IF NOT EXISTS team_messages_thread_idx ON team_messages (thread_root_id, created_at) WHERE thread_root_id IS NOT NULL;
INSERT INTO team_channels (kind, name, topic)
SELECT 'channel', 'general', 'Company-wide news and chat'
 WHERE NOT EXISTS (SELECT 1 FROM team_channels WHERE kind = 'channel' AND lower(name) = 'general');
