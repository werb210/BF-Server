-- BF_SERVER_BLOCK_v705_SCHEDULED_SEND — parked scheduled emails. Each row points
-- at an Outlook draft built at schedule time; the worker sends it when due.
CREATE TABLE IF NOT EXISTS scheduled_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL,
  draft_id    text NOT NULL,
  silo        text NOT NULL DEFAULT 'BF',
  subject     text,
  to_preview  text,
  send_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_due ON scheduled_emails (status, send_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_emails_user ON scheduled_emails (user_id, status);
