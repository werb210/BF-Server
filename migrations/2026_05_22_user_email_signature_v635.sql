-- BF_SERVER_BLOCK_v635: per-user email signature
-- user_settings may not exist on every deploy yet; create it idempotently.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id uuid PRIMARY KEY,
  email_signature_html text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS email_signature_html text;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
