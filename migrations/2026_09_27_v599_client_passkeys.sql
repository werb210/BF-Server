-- BF_SERVER_BLOCK_v599 - client passkeys (browser sign-in with Face ID / Touch ID / Windows Hello).
-- Kept apart from the staff webauthn_* tables on purpose: a client credential
-- must never be able to mint a staff token, and the two use different RP IDs.
CREATE TABLE IF NOT EXISTS client_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  device_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS client_passkeys_phone_idx ON client_passkeys (phone) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS client_passkey_challenges (
  challenge text PRIMARY KEY,
  phone text,
  kind text NOT NULL CHECK (kind IN ('register', 'login')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);
