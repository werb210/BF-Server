-- v761 — team chat reactions + edit/delete + reply. Idempotent.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS edited_at   timestamptz;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS deleted_at  timestamptz;
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS reply_to_id uuid;
CREATE TABLE IF NOT EXISTS team_message_reactions (
  message_id uuid NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS team_message_reactions_msg_idx ON team_message_reactions (message_id);
