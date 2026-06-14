-- BF_SERVER_WEBAUTHN_v1 — passkey (WebAuthn) credentials + short-lived challenge store.
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key    text NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    text[] NULL,
  device_label  text NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NULL
);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge  text NOT NULL,
  user_id    uuid NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('register','login')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_challenge ON webauthn_challenges(challenge);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user ON webauthn_challenges(user_id);
