-- BF_SERVER_BLOCK_v646_COMPLETE_COMMS_v1
-- Adds:
--   1. communications_messages.attachments JSONB column for mini-portal +
--      Messages-tab attachments (each item: {name,contentType,dataUrl})
--   2. messages_typing presence table (ephemeral, TTL-filtered on read)
--      so staff + client can see "the other side is typing" without a
--      persistent state machine.

ALTER TABLE communications_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NULL;

CREATE TABLE IF NOT EXISTS messages_typing (
  contact_id   UUID         NOT NULL,
  side         TEXT         NOT NULL CHECK (side IN ('staff', 'client')),
  actor_label  TEXT         NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, side)
);

CREATE INDEX IF NOT EXISTS idx_messages_typing_updated_at
  ON messages_typing (updated_at);
