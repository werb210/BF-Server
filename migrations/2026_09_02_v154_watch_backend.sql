ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_callback_number text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS callback_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS watch_link_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watch_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'watchos' CHECK (platform='watchos'), application text NOT NULL DEFAULT 'boreal-dialer',
  name text, app_version text, standalone_routing_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS watch_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL REFERENCES watch_devices(id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, refresh_expires_at timestamptz NOT NULL,
  rotated_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watch_push_registrations (
  device_id uuid PRIMARY KEY REFERENCES watch_devices(id) ON DELETE CASCADE, token_hash text NOT NULL,
  token_ciphertext text NOT NULL, push_type text NOT NULL CHECK (push_type='standard'),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS watch_call_bridges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES watch_devices(id) ON DELETE RESTRICT, destination text NOT NULL,
  callback_number text NOT NULL, line text NOT NULL CHECK (line IN ('BF','BI','SLF')),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('requesting','waitingForCallback','bridging','ringing','connected','ended','failed')),
  version integer NOT NULL DEFAULT 1, provider_call_sid text, error_code text,
  idempotency_key text NOT NULL, request_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  UNIQUE(staff_user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS watch_devices_staff_idx ON watch_devices(staff_user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS watch_calls_staff_idx ON watch_call_bridges(staff_user_id,created_at DESC);
