-- BF_SERVER_CLIENT_FACE_ID_v296
-- One row per phone the client turned on Face ID sign-in for. Only a SHA-256
-- hash of the device secret is stored; the secret itself lives in the phone's
-- Keychain behind Face ID. Each sign-in rotates the secret.
CREATE TABLE IF NOT EXISTS client_device_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  secret_hash  text NOT NULL,
  device_label text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_client_device_credentials_phone ON client_device_credentials (phone) WHERE revoked_at IS NULL;
