-- BF_SERVER_BLOCK_v552_NOTIFY_CLIENT - which channel each client notice went out on.
CREATE TABLE IF NOT EXISTS client_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text,
  phone10 text NOT NULL,
  kind text NOT NULL,
  channel text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_notifications_app_idx ON client_notifications (application_id, created_at DESC);
