-- v750 — internal staff "Team" chat (channels / DMs / groups). Idempotent.
CREATE TABLE IF NOT EXISTS team_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL DEFAULT 'channel',   -- 'channel' | 'dm' | 'group'
  name        text,
  dm_key      text,                              -- canonical key for 1:1 dedupe
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_channels_kind_chk CHECK (kind IN ('channel', 'dm', 'group'))
);
CREATE UNIQUE INDEX IF NOT EXISTS team_channels_dm_key_uidx
  ON team_channels (dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_channel_members (
  channel_id   uuid NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  last_read_at timestamptz,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS team_channel_members_user_idx
  ON team_channel_members (user_id);

CREATE TABLE IF NOT EXISTS team_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid NOT NULL REFERENCES team_channels(id) ON DELETE CASCADE,
  sender_id   uuid,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_messages_channel_idx
  ON team_messages (channel_id, created_at DESC);
