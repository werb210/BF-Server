-- BF_SERVER_TEAM_PREFS_v643 - per-conversation mute, and each person's status (custom text,
-- Do Not Disturb, idle Away) for Team chat.
ALTER TABLE team_channel_members ADD COLUMN IF NOT EXISTS muted boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS team_user_status (
  user_id uuid PRIMARY KEY,
  status_text text,
  status_emoji text,
  status_until timestamptz,
  dnd_until timestamptz,
  away boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
