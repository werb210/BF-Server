-- BF_SERVER_CHAT_MESSAGES_COLUMNS_v411
-- Production chat_messages is missing the columns the Maya transcript writer
-- expects. Live error, one per Maya turn:
--   column "role" of relation "chat_messages" does not exist
-- The persist path is wrapped in a best-effort catch, so this threw silently and
-- Communications -> Maya showed "No Maya conversations yet." for every
-- conversation ever held. Idempotent: safe to re-run, safe if already present.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS role       text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS message    text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content    text;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata   jsonb;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
  ON chat_messages (session_id, created_at);
