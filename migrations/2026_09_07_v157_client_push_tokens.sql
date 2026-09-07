-- BF_SERVER_CLIENT_PUSH_TOKEN_v1
CREATE TABLE IF NOT EXISTS client_push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text,
  token text NOT NULL,
  platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS client_push_tokens_user_idx ON client_push_tokens (user_id);
