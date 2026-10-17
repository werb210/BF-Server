-- BF_SERVER_v820_WATCH_CALLS - APNs alert tokens for the staff iPhone dialler (missed call, voicemail, client
-- message, SMS, Maya handoff alerts). One row per device token; a token moves to whoever registered it last.
-- Idempotent: safe to run again.
CREATE TABLE IF NOT EXISTS staff_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  environment text NOT NULL DEFAULT 'production',
  app text NOT NULL DEFAULT 'dialer-ios',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text NULL
);

CREATE INDEX IF NOT EXISTS staff_push_tokens_user_idx ON staff_push_tokens (user_id, app);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_push_tokens_environment_chk') THEN
    ALTER TABLE staff_push_tokens
      ADD CONSTRAINT staff_push_tokens_environment_chk CHECK (environment IN ('production', 'sandbox'));
  END IF;
END $$;
