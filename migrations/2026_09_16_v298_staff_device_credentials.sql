-- BF_SERVER_STAFF_FACE_ID_v298
-- Face ID sign-in for the staff dialer app. Only a SHA-256 hash of the device
-- secret is stored; the secret lives in the phone's Keychain behind Face ID and
-- rotates on every sign-in. token_version is captured so a forced sign-out
-- (token_version bump) also ends Face ID sign-in.
CREATE TABLE IF NOT EXISTS staff_device_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  secret_hash   text NOT NULL,
  token_version integer NOT NULL DEFAULT 0,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
  revoked_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_staff_device_credentials_user ON staff_device_credentials (user_id) WHERE revoked_at IS NULL;
