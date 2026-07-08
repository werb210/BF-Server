-- BF_SERVER_MESSAGES_LIST_PERF_v1 - the Communications page was timing out. messages-list
-- scans every message in the silo, then runs two window functions over the whole set on
-- every load. These indexes let the rewritten DISTINCT ON pick the latest message per
-- thread directly, and let the unread count hit a small partial index.
CREATE INDEX IF NOT EXISTS idx_cm_silo_type_contact_created
  ON communications_messages (silo, type, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cm_silo_contact_created
  ON communications_messages (silo, contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cm_unread_inbound
  ON communications_messages (silo, contact_id)
  WHERE read_at IS NULL AND direction = 'inbound';
