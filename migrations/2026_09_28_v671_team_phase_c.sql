-- BF_SERVER_TEAM_PHASE_C_v671 - Team chat Phase C: posts from Boreal automations and Maya (no human
-- sender, a bot name instead), and Save for later / Remind me.
ALTER TABLE team_messages ADD COLUMN IF NOT EXISTS bot text;
CREATE TABLE IF NOT EXISTS team_saved (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES team_messages(id) ON DELETE CASCADE,
  remind_at timestamptz,
  reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS team_saved_due_idx ON team_saved (remind_at) WHERE reminded_at IS NULL AND remind_at IS NOT NULL;
