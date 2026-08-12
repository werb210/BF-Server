-- BF_SERVER_OPEN_TRUTH_v52
-- Preserve fetch metadata and distinguish new classified events from legacy rows.
ALTER TABLE email_open_events ADD COLUMN IF NOT EXISTS user_agent TEXT;
ALTER TABLE email_open_events ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE email_open_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'unverified';

CREATE INDEX IF NOT EXISTS email_open_events_log_source_idx
  ON email_open_events (email_log_id, source);
CREATE INDEX IF NOT EXISTS email_open_events_log_opened_idx
  ON email_open_events (email_log_id, opened_at DESC);
