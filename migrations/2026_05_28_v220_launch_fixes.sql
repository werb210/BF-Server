-- BF_SERVER_BLOCK_v220_LAUNCH_FIXES_v1 + HOTFIX_MIGRATION_v1
-- Hotfix: previous version did CREATE TABLE IF NOT EXISTS issues + CREATE INDEX
-- on (source, kind). issues table pre-existed from 113_issues_table.sql with
-- a different schema, so the INDEX statement failed. Rewritten to ALTER the
-- existing tables idempotently and only CREATE TABLE for genuinely new tables.

-- ── issues: extend the existing schema for Maya escalate "Report Issue" ─────
-- Existing schema: id, title, description, screenshot_url, contact_id (FK),
-- application_id (FK text), status (open/in_progress/resolved), submitted_by,
-- metadata jsonb, created_at, updated_at.
-- Add columns needed by the new Maya escalate path. All nullable; no NOT NULL
-- constraints because pre-existing rows would violate them.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS source     TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS kind       TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS conversation_id UUID;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS contact_email  TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS contact_phone  TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS page_url       TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS screenshot_blob_name TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS silo TEXT NOT NULL DEFAULT 'BF';

-- Note: status already exists with CHECK constraint (open/in_progress/resolved).
-- 'open' is the default, matches what the new GET /api/issues filter expects.

CREATE INDEX IF NOT EXISTS idx_issues_source_kind ON issues(source, kind);
CREATE INDEX IF NOT EXISTS idx_issues_status_created ON issues(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_silo_created ON issues(silo, created_at DESC);

-- ── communications_conversations: genuinely new table for v220 ──────────────
CREATE TABLE IF NOT EXISTS communications_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  contact_name TEXT,
  contact_phone TEXT,
  channel TEXT NOT NULL,
  last_message_preview TEXT,
  last_message_at TIMESTAMPTZ,
  unread INT NOT NULL DEFAULT 0,
  silo TEXT NOT NULL DEFAULT 'BF',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conv_silo_channel
  ON communications_conversations(silo, channel, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_contact_phone
  ON communications_conversations(contact_phone)
  WHERE contact_phone IS NOT NULL;

-- ── communications_messages: extend the existing table ─────────────────────
-- Existing columns already include id, body, direction, application_id,
-- staff_name, created_at (and more from prior migrations).
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS conversation_id UUID;
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE communications_messages ADD COLUMN IF NOT EXISTS twilio_message_sid TEXT;

-- Defensive: only add direction if it isn't already there (it almost certainly is).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='communications_messages' AND column_name='direction') THEN
    ALTER TABLE communications_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_comm_msg_conv
  ON communications_messages(conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_msg_twilio_sid
  ON communications_messages(twilio_message_sid)
  WHERE twilio_message_sid IS NOT NULL;
