-- BF_SERVER_BLOCK_v636_MESSAGES_TAB_FIXES_v1
-- Presence column for the offline-SMS fallback in POST
-- /api/communications/messages/send + covering index on the
-- messages-list non-SMS query. Fully idempotent.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS last_portal_seen_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_applications_last_portal_seen_at
  ON applications(last_portal_seen_at)
  WHERE last_portal_seen_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_comm_msg_silo_contact_created
  ON communications_messages(silo, contact_id, created_at DESC)
  WHERE (type IS NULL OR type <> 'sms');
