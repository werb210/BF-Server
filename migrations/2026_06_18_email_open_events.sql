-- #48 Option B — one row per email open (every open, each timestamped).
-- crm_email_log.opened_at stays as the first-open stamp for back-compat.
CREATE TABLE IF NOT EXISTS email_open_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_log_id uuid NOT NULL,
  opened_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_open_events_log_idx ON email_open_events (email_log_id);
