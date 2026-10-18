-- BF_SERVER_v823_LIVE_ACTIVITY - the client app's lock-screen status (iPhone Live Activity token / Android status
-- notification). One row per application and platform; last_signature is what the phone last showed.
-- Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS client_status_watch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id text NOT NULL,
  platform text NOT NULL,
  user_id text NULL,
  activity_token text NULL,
  activity_started_at timestamptz NULL,
  start_token text NULL,
  environment text NOT NULL DEFAULT 'production',
  last_signature text NULL,
  last_sent_at timestamptz NULL,
  ended_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Columns added after the first cut of this table (no-ops on a fresh database).
ALTER TABLE client_status_watch ADD COLUMN IF NOT EXISTS activity_started_at timestamptz NULL;
ALTER TABLE client_status_watch ADD COLUMN IF NOT EXISTS start_token text NULL;

CREATE UNIQUE INDEX IF NOT EXISTS client_status_watch_app_platform_uidx ON client_status_watch (application_id, platform);
CREATE INDEX IF NOT EXISTS client_status_watch_open_idx ON client_status_watch (updated_at) WHERE ended_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_status_watch_platform_chk') THEN
    ALTER TABLE client_status_watch ADD CONSTRAINT client_status_watch_platform_chk CHECK (platform IN ('ios', 'android'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_status_watch_environment_chk') THEN
    ALTER TABLE client_status_watch ADD CONSTRAINT client_status_watch_environment_chk CHECK (environment IN ('production', 'sandbox'));
  END IF;
END $$;
