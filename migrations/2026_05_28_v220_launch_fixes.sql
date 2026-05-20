-- BF_SERVER_BLOCK_v220_LAUNCH_FIXES_v1
-- Tables / columns needed by the new routes. All idempotent.

CREATE TABLE IF NOT EXISTS issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL DEFAULT 'maya_escalate',
  kind TEXT NOT NULL,
  description TEXT,
  conversation_id UUID,
  contact_email TEXT,
  contact_phone TEXT,
  page_url TEXT,
  screenshot_url TEXT,
  screenshot_blob_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  silo TEXT NOT NULL DEFAULT 'BF'
);
CREATE INDEX IF NOT EXISTS idx_issues_source_kind ON issues(source, kind);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status, created_at DESC);

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='communications_messages' AND column_name='conversation_id') THEN
    ALTER TABLE communications_messages ADD COLUMN conversation_id UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='communications_messages' AND column_name='channel') THEN
    ALTER TABLE communications_messages ADD COLUMN channel TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='communications_messages' AND column_name='direction') THEN
    ALTER TABLE communications_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='communications_messages' AND column_name='twilio_message_sid') THEN
    ALTER TABLE communications_messages ADD COLUMN twilio_message_sid TEXT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_comm_msg_twilio_sid
  ON communications_messages(twilio_message_sid) WHERE twilio_message_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_comm_msg_conv ON communications_messages(conversation_id, created_at);
